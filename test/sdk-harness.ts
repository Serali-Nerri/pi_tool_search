import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionAPI, type ExtensionFactory, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream, type Api, type AssistantMessage, type Model, type ToolCall, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerToolSearch } from "../src/lifecycle.ts";

export function fixtureModel(api: Api = "openai-responses", native = true): Model<Api> {
	const compat = native ? {
		supportsMidConvoSystemMessages: true,
		...(api === "anthropic-messages" ? { supportsMidConvoToolChanges: true }
			: api === "openai-completions" ? { supportsMidConvoToolAdditions: true }
				: api === "openai-codex-responses" ? { supportsToolSearch: true } : { supportsAdditionalTools: true }),
	} : {};
	return {
		id: "fixture", name: "Fixture", provider: "openai", api, baseUrl: "http://127.0.0.1:1",
		reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000, maxTokens: 1000, compat,
	};
}

let nextCall = 0;
export function toolCall(name: string, args: ToolCall["arguments"] = {}): ToolCall {
	return { type: "toolCall", id: `fixture_call_${++nextCall}`, name, arguments: args };
}

export async function sdkFixture(options: {
	model?: Model<Api>;
	tools?: string[];
	entries?: SessionEntry[];
	customPrompt?: string;
	providerName?: string;
	beforeLoader?: ExtensionFactory;
	extension?: ExtensionFactory;
} = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-tool-search-sdk-"));
	const settingsManager = SettingsManager.inMemory({
		packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
	});
	let providerAPI!: ExtensionAPI;
	const errors: unknown[] = [];
	const provider: ExtensionFactory = (pi) => {
		providerAPI = pi;
		const register = (name: string) => pi.registerTool({
			name, label: name, description: `${name} fixture`, parameters: Type.Object({}),
			promptSnippet: `${name} structured snippet`, promptGuidelines: [`Use ${name} carefully.`],
			async execute() { return { content: [{ type: "text", text: name }], details: {} }; },
		});
		pi.on("session_start", () => { register("alpha"); register("beta"); });
		pi.registerTool({
			name: "ls", label: "Register late", description: "Register a late fixture", parameters: Type.Object({}),
			async execute() { register("late"); return { content: [{ type: "text", text: "registered" }], details: {} }; },
		});
		// Deterministic compaction without any summarization request.
		pi.on("session_before_compact", (event) => {
			const lastUser = [...event.branchEntries].reverse().find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!lastUser) throw new Error("No user entry to keep");
			return { compaction: { summary: "Fixture summary", firstKeptEntryId: lastUser.id, tokensBefore: event.preparation.tokensBefore } };
		});
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		...(options.customPrompt === undefined ? {} : { systemPromptOverride: () => options.customPrompt }),
		extensionFactories: [
			...(options.beforeLoader ? [{ name: "fixture-before-loader", factory: options.beforeLoader }] : []),
			{ name: "fixture-loader", factory: (pi) => registerToolSearch(pi, root, "<inline:fixture-loader>", root) },
			{ name: options.providerName ?? "fixture-provider", factory: provider },
			...(options.extension ? [{ name: "fixture-extra", factory: options.extension }] : []),
		],
	});
	try {
		await resourceLoader.reload();
		if (resourceLoader.getExtensions().errors.length) throw new Error(JSON.stringify(resourceLoader.getExtensions().errors));
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-store.json"),
			allowModelNetwork: false, refreshOnCreate: false,
		});
		await modelRuntime.setRuntimeApiKey("openai", "fixture-not-a-real-key");
		const sessionManager = SessionManager.inMemory(root, undefined, options.entries);
		const { session } = await createAgentSession({
			cwd: root, agentDir: root, resourceLoader, modelRuntime, sessionManager, settingsManager,
			model: options.model ?? fixtureModel(), ...(options.tools ? { tools: options.tools } : {}),
		});
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
		const requests: TranscriptContext[] = [];
		const responses: AssistantMessage["content"][] = [];
		session.agent.getApiKey = () => "fixture-not-a-real-key";
		session.agent.streamFunction = (model, context) => {
			requests.push(structuredClone(context));
			const content = responses.shift() ?? [{ type: "text", text: "ok" }];
			const message: AssistantMessage = {
				role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
				usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
				stream.end();
			});
			return stream;
		};
		return {
			root, session, sessionManager, settingsManager, requests, responses, errors,
			get providerAPI() { return providerAPI; },
			async cleanup() { session.dispose(); await rm(root, { recursive: true, force: true }); },
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

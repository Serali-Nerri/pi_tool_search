import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { globalToolSearchConfigPath, type ToolSearchProjectConfig } from "../src/config.ts";
import { toolSourceIdentity } from "../src/registry.ts";
import { fixtureModel, mockModel, toolCall } from "./sdk-harness.ts";

// The pinned devDependency is byte-identical to the installed 1.14.0 package.
// Optional paths also let this run against the actual installed package + SDK.
const require = createRequire(import.meta.url);
const subagentsDir = process.env.PI_TOOL_SEARCH_TEST_SUBAGENTS_DIR ?? dirname(require.resolve("pi-subagents-lite/package.json"));
const sdkEntry = process.env.PI_TOOL_SEARCH_TEST_SDK_ENTRY;
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(sdkEntry ? pathToFileURL(resolve(sdkEntry)).href : "@earendil-works/pi-coding-agent");

interface RunnerBindings {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	runAgent: (ctx: ExtensionContext, type: string, prompt: string, options: {
		pi: ExtensionAPI;
		model: ReturnType<typeof fixtureModel>;
		onSessionCreated: (session: AgentSession) => void;
		onToolActivity: (event: { toolName: string }) => void;
	}) => Promise<{ session: AgentSession; responseText: string; modelError?: string }>;
}

test("real pi-subagents-lite replace runner: automatic loading, execution, whitelist, isolation and fallback", { timeout: 60_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-tool-search-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const previousEnv = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	const fetchMock = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request in subagents fixture"); });
	const sessions: AgentSession[] = [];
	try {
		assert.equal(JSON.parse(await readFile(join(subagentsDir, "package.json"), "utf8")).version, "1.14.0");
		await mkdir(cwd);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		// Each child constructs its own ModelRuntime before onSessionCreated.
		// Satisfy prompt preflight with a fake credential in the disposable dir.
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-not-a-real-key" } }));
		const providerDir = join(agentDir, "extensions", "fixture-tools");
		await mkdir(providerDir, { recursive: true });
		const providerPath = join(providerDir, "index.ts");
		await writeFile(providerPath, `
import { Type } from "typebox";
export default function (pi) {
	for (const name of ["web_search", "fetch_content", "get_search_content", "source_check", "blocked", "outside"]) {
		pi.registerTool({ name, label: name, description: name + " fixture capability",
			promptSnippet: name + " fixture snippet", promptGuidelines: ["Use " + name + " fixture carefully."],
			parameters: Type.Object({ query: Type.String() }),
			async execute(_id, params) { return { content: [{ type: "text", text: name + ":" + params.query }], details: {} }; },
		});
	}
}
`);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({
			packages: [], extensions: [resolve("src/index.ts")], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
		}));
		await writeFile(join(agentDir, "subagents-lite.json"), JSON.stringify({ agent: {
			systemPromptMode: "replace", includeContextFiles: false, loadExtensionsImplicitly: false, loadSkillsImplicitly: false,
		} }));
		const baseTools = ["read", "bash", "grep", "find"];
		const webTools = ["web_search", "fetch_content", "get_search_content", "source_check"];
		for (const name of ["Explore", "general-purpose", "oracle", "NoLoader", "Inherited"]) {
			const tools = [...baseTools, ...(name === "general-purpose" ? ["edit", "write"] : []), ...(name === "NoLoader" ? [] : ["tool_search"]), ...webTools, "blocked"];
			await writeFile(join(agentDir, "agents", `${name}.md`), `---\nname: ${name}\nextensions: [pi-tool-search, fixture-tools]\ntools: [${tools.join(", ")}]\nskills: false\ninclude_context_files: false\n${name === "Inherited" ? "include_system_prompt: true\n" : ""}---\n\nRead-only fixture role. Never delete files.\n`);
		}

		// Load the actual runner through Pi's jiti aliases, just as an installed
		// extension does. Plain Node/tsx cannot import this package's CJS-shaped
		// TypeScript directly against the SDK's ESM-only exports.
		const bridgePath = join(root, "bridge.ts");
		const modulePath = (file: string) => JSON.stringify(join(subagentsDir, "src", file));
		await writeFile(bridgePath, `
import { runAgent } from ${modulePath("agents/agent-runner.ts")};
import { registerAgents } from ${modulePath("agents/agent-types.ts")};
import { scanAgentFilesInDir, mergeAgents } from ${modulePath("agents/agent-discovery.ts")};
export default async function (pi) {
	const agents = await scanAgentFilesInDir(${JSON.stringify(join(agentDir, "agents"))}, "user");
	registerAgents(mergeAgents(new Map(), agents, [], []), { disableDefaultAgents: true });
	pi.on("session_start", (_event, ctx) => pi.events.emit("fixture:runner", { runAgent, pi, ctx }));
}
`);
		const eventBus = sdk.createEventBus();
		let bindings: RunnerBindings | undefined;
		eventBus.on("fixture:runner", (data) => { bindings = data as RunnerBindings; });
		const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
		const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus, additionalExtensionPaths: [bridgePath], noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const model = fixtureModel();
		const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
		await modelRuntime.setRuntimeApiKey("openai", "fixture-not-a-real-key");
		const { session: parent } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime, model, sessionManager: sdk.SessionManager.inMemory(cwd) });
		sessions.push(parent);
		const parentErrors: unknown[] = [];
		await parent.bindExtensions({ mode: "print", onError: (error) => parentErrors.push(error) });
		assert.ok(bindings);
		const runner = bindings;
		const parentMock = mockModel(parent);
		parentMock.responses.push([toolCall("tool_search", { tool_names: ["fetch_content"] })]);
		await parent.prompt("parent loads fetch_content only");
		const provider = parent.getAllTools().find((tool) => tool.name === "blocked")!;
		const config: ToolSearchProjectConfig = { version: 1, tools: [{ name: "blocked", source: toolSourceIdentity(provider, cwd), policy: "excluded" }] };
		const childErrors: string[] = [];
		const spawn = async (name: string, load = false, policy: ToolSearchProjectConfig | null = config) => {
			if (policy) await writeFile(globalToolSearchConfigPath(agentDir), JSON.stringify(policy));
			else await rm(globalToolSearchConfigPath(agentDir), { force: true });
			let mock: ReturnType<typeof mockModel> | undefined;
			let originalPrefix: string | undefined;
			const result = await runner.runAgent(runner.ctx, name, "Fixture task; no real network or file tools.", {
				pi: runner.pi, model,
				onToolActivity: ({ toolName }) => { if (toolName.startsWith("extension-error:")) childErrors.push(toolName); },
				onSessionCreated(session) {
					sessions.push(session);
					assert.ok(session instanceof sdk.AgentSession, "runner and extension loader must share the selected SDK");
					assert.deepEqual(session.resourceLoader.getExtensions().errors, []);
					originalPrefix = session.resourceLoader.getSystemPrompt();
					mock = mockModel(session);
					if (load) mock.responses.push(
						[toolCall("tool_search", { tool_names: ["web_search", "blocked", "outside"] })],
						[toolCall("web_search", { query: "success" })],
						[toolCall("tool_search", { tool_names: ["web_search"] })],
					);
				},
			});
			assert.equal(result.modelError, undefined);
			assert.ok(mock && originalPrefix);
			assert.equal(mock.requests[0].messages.find((message) => message.role === "system")?.sections?.preamble, originalPrefix);
			return { ...result, ...mock };
		};

		for (const name of ["Explore", "general-purpose", "oracle"]) {
			const child = await spawn(name, true);
			const names = (index: number) => getCurrentTools(child.requests[index].messages).map((tool) => tool.name);
			const initial = [...baseTools, ...(name === "general-purpose" ? ["edit", "write"] : []), "tool_search"];
			assert.deepEqual(new Set(names(0)), new Set(initial));
			assert.equal(child.requests.length, 4);
			const manifest = getCurrentTools(child.requests[0].messages).find((tool) => tool.name === "tool_search")!.description;
			for (const tool of webTools) assert.ok(manifest.includes(tool));
			assert.doesNotMatch(manifest, /blocked|outside/);
			for (let i = 1; i < child.requests.length; i++) {
				assert.deepEqual(new Set(names(i)), new Set([...initial, "web_search"]));
				assert.equal(getCurrentSystemPrompt(child.requests[i].messages), getCurrentSystemPrompt(child.requests[0].messages));
			}
			const executed = child.session.messages.find((message) => message.role === "toolResult" && message.toolName === "web_search");
			assert.ok(executed?.role === "toolResult" && !executed.isError);
			assert.match(JSON.stringify(executed.content), /web_search:success/);
			const results = child.session.messages.filter((message) => message.role === "toolResult" && message.toolName === "tool_search");
			assert.match(JSON.stringify(results[0]), /Use web_search fixture carefully/);
			assert.doesNotMatch(JSON.stringify(results.at(-1)), /Tool guidance:/);
		}
		const fresh = await spawn("Explore");
		assert.ok(!getCurrentTools(fresh.requests[0].messages).some((tool) => webTools.includes(tool.name)));
		await parent.prompt("parent still has its own activation state");
		assert.ok(parent.getActiveToolNames().includes("fetch_content"));
		assert.ok(!parent.getActiveToolNames().includes("web_search"));

		const noLoader = await spawn("NoLoader");
		const noLoaderTools = getCurrentTools(noLoader.requests[0].messages).map((tool) => tool.name);
		assert.ok(!noLoaderTools.includes("tool_search"));
		assert.ok(webTools.every((tool) => noLoaderTools.includes(tool)));
		// A copied parent prompt is opaque text, not an authored sections.tools
		// override. Its words stay intact without granting executable tools.
		const inherited = await spawn("Inherited", true);
		const inheritedTools = getCurrentTools(inherited.requests[0].messages).map((tool) => tool.name);
		assert.ok(inheritedTools.includes("tool_search"));
		assert.ok(!webTools.some((tool) => inheritedTools.includes(tool)));
		const inheritedSystem = inherited.requests[0].messages.find((message) => message.role === "system")!;
		assert.match(inheritedSystem.sections?.preamble ?? "", /<tools>/);
		assert.match(inheritedSystem.sections?.tools ?? "", /tool_search/);
		assert.ok(inherited.session.messages.some((message) => message.role === "toolResult" && message.toolName === "web_search" && !message.isError));
		const defaultChild = await spawn("Explore", false, null);
		assert.ok(getCurrentTools(defaultChild.requests[0].messages).some((tool) => tool.name === "tool_search"));
		assert.ok(!getCurrentTools(defaultChild.requests[0].messages).some((tool) => tool.name === "web_search"));
		const eagerChild = await spawn("Explore", false, { ...config, mode: "eager" });
		const eagerTools = getCurrentTools(eagerChild.requests[0].messages).map((tool) => tool.name);
		assert.ok(!eagerTools.includes("tool_search"));
		assert.ok(webTools.every((tool) => eagerTools.includes(tool)));
		assert.ok(!eagerTools.includes("blocked") && !eagerTools.includes("outside"));
		assert.deepEqual(parentErrors, []);
		assert.deepEqual(childErrors, []);
		assert.equal(fetchMock.mock.callCount(), 0);
	} finally {
		for (const session of sessions) session.dispose();
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});

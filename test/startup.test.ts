import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerToolSearch } from "../src/lifecycle.ts";
import { toolKey } from "../src/registry.ts";

const testRoot = mkdtempSync(join(tmpdir(), "pi-tool-search-startup-"));
process.env.PI_CODING_AGENT_DIR = testRoot;
after(() => rmSync(testRoot, { recursive: true, force: true }));

const loader = {
	name: "startup-tool-search",
	factory: ((pi) => registerToolSearch(pi, testRoot, "<inline:startup-tool-search>", testRoot)) satisfies ExtensionFactory,
};
const provider = {
	name: "startup-provider",
	factory: ((pi) => {
		// Mode-dependent extensions register after obtaining the session context.
		pi.on("session_start", () => {
			pi.registerTool({
				name: "process",
				label: "Process",
				description: "Manage background processes",
				promptSnippet: "Manage background processes",
				promptGuidelines: ["Use process to manage background commands."],
				parameters: Type.Object({}),
				async execute() { return { content: [{ type: "text", text: "Done" }], details: {} }; },
			});
		});
	}) satisfies ExtensionFactory,
};

for (const native of [false, true]) {
	for (const providerFirst of [false, true]) {
		test(`${native ? "native Codex" : "portable"} defers startup tools before input with provider ${providerFirst ? "first" : "last"}`, async () => {
			const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: false } });
			const resourceLoader = new DefaultResourceLoader({
				cwd: testRoot,
				agentDir: testRoot,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: providerFirst ? [provider, loader] : [loader, provider],
			});
			await resourceLoader.reload();
			assert.deepEqual(resourceLoader.getExtensions().errors, []);
			const modelRuntime = await ModelRuntime.create({
				authPath: join(testRoot, "auth.json"),
				modelsPath: null,
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			const sessionManager = SessionManager.inMemory(testRoot);
			const { session } = await createAgentSession({
				cwd: testRoot,
				agentDir: testRoot,
				modelRuntime,
				resourceLoader,
				settingsManager,
				sessionManager,
				model: {
					id: "startup-test",
					name: "Startup test",
					provider: "startup-test",
					api: native ? "openai-codex-responses" : "openai-completions",
					baseUrl: "http://127.0.0.1:1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 1000,
					...(native ? { compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true } } : {}),
				},
			});
			const errors: unknown[] = [];
			try {
				await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error) });
				assert.deepEqual(errors, []);
				assert.ok(session.getAllTools().some(({ name }) => name === "process"));
				assert.equal(session.getActiveToolNames().includes("process"), false);
				assert.ok(session.getActiveToolNames().includes("tool_search"));
				assert.match(session.getToolDefinition("tool_search")!.description, /process — Manage background processes/);
				assert.doesNotMatch(session.systemPrompt, /Use process to manage|\n- process:/);
				const active = session.getActiveToolNames();
				await session.reload();
				assert.deepEqual(errors, []);
				assert.deepEqual(session.getActiveToolNames(), active);
				assert.match(session.getToolDefinition("tool_search")!.description, /process — Manage background processes/);
				const processTool = session.getAllTools().find(({ name }) => name === "process")!;
				sessionManager.appendCustomEntry("pi-tool-search.state", {
					enabled: true,
					loadedKeys: [toolKey(processTool)],
				});
				await session.reload();
				assert.deepEqual(errors, []);
				assert.ok(session.getActiveToolNames().includes("process"), "Restore activation after the provider registers again");
			} finally {
				session.dispose();
			}
		});
	}
}

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerToolSearch } from "../src/index.ts";
import { policyRecordKey, type ToolPolicy, type ToolPolicyRecord } from "../src/registry.ts";

const testRoot = mkdtempSync(`${tmpdir()}/pi-tool-search-lifecycle-`);
process.env.PI_CODING_AGENT_DIR = testRoot;
after(() => rmSync(testRoot, { recursive: true, force: true }));
const nativeModel = { api: "openai-responses", compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } };
function completeEvent(event: string, args: unknown[]): unknown[] {
	if (event !== "before_agent_start") return args;
	return [{ systemPrompt: "", systemPromptOptions: { cwd: testRoot, selectedTools: [], toolSnippets: { read: "Read files" }, toolGuidelines: {}, sections: {} }, ...(args[0] as object) }, ...args.slice(1)];
}

interface RuntimeTool {
	name: string;
	description: string;
	parameters?: unknown;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	renderShell?: "default" | "self";
	execute?: (...args: any[]) => Promise<any>;
	renderCall?: (args: unknown, theme: unknown, context: unknown) => Component;
	renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => Component;
}

interface ExternalTool {
	name: string;
	description: string;
	source: string;
	path?: string;
}

interface RuntimeCommand {
	handler: (args: string, context: any) => Promise<void>;
}

interface RenderContextOptions {
	id: string;
	expanded?: boolean;
	isPartial?: boolean;
	isError?: boolean;
	executionStarted?: boolean;
	lastComponent?: Component;
	state?: Record<string, unknown>;
}

interface HarnessOptions {
	agentDir?: string;
	loaderPath?: string;
	externalTools?: ExternalTool[];
	activeTools?: string[];
	refreshActivatesAllowlist?: boolean;
	/** Opaque startup text; metadata is read only from structured event inputs. */
	systemPrompt?: string;
}

function createHarness(options: HarnessOptions = {}) {
	const tools: RuntimeTool[] = [];
	const commands = new Map<string, RuntimeCommand>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	let externalTools = options.externalTools ?? [];
	let activeTools = [...(options.activeTools ?? externalTools.map(({ name }) => name))];
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const allToolNames = () => new Set([...externalTools.map(({ name }) => name), ...tools.map(({ name }) => name)]);
	const pi = {
		registerTool(target: unknown) {
			const tool = target as RuntimeTool;
			const existing = tools.findIndex(({ name }) => name === tool.name);
			if (existing === -1) tools.push(tool);
			else tools[existing] = tool;
			if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
			if (options.refreshActivatesAllowlist) activeTools = [...allToolNames()];
		},
		registerCommand(name: string, command: RuntimeCommand) {
			commands.set(name, command);
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		getAllTools() {
			return [
				...externalTools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: {},
					sourceInfo: {
						source: tool.source,
						path: tool.path ?? `/extensions/${tool.source}/index.ts`,
						scope: "user",
						origin: "package",
					},
				})),
				...tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters ?? {},
					promptGuidelines: tool.promptGuidelines,
					sourceInfo: {
						source: "./src/index.ts",
						path: options.loaderPath ?? resolve("src/index.ts"),
						scope: "temporary",
						origin: "top-level",
					},
				})),
			];
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			const registered = allToolNames();
			activeTools = [...new Set(names.filter((name) => registered.has(name)))];
		},
		appendEntry(customType: string, data: unknown) {
			appendedEntries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	// Always inject a disposable agent dir; config tests must never reach the real global file.
	registerToolSearch(pi, process.cwd(), resolve("src/index.ts"), options.agentDir ?? testRoot);
	return {
		tools,
		tool(name: string) {
			const found = tools.find((candidate) => candidate.name === name);
			assert.ok(found, `tool ${name} was not registered`);
			return found;
		},
		command(name: string) {
			const found = commands.get(name);
			assert.ok(found, `command ${name} was not registered`);
			return found;
		},
	emit(event: string, ...args: unknown[]) {
			for (const handler of handlers.get(event) ?? []) handler(...completeEvent(event, args));
		},
		async emitAsync(event: string, ...args: unknown[]) {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(...completeEvent(event, args)));
			return results;
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			const registered = allToolNames();
			activeTools = [...new Set(names.filter((name) => registered.has(name)))];
		},
		addExternalTool(tool: ExternalTool) {
			externalTools = [tool, ...externalTools.filter(({ name }) => name !== tool.name)];
			if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
			if (options.refreshActivatesAllowlist) activeTools = [...allToolNames()];
		},
		appendedEntries,
	};
}

function renderContext(args: unknown, options: RenderContextOptions): unknown {
	return {
		args,
		toolCallId: options.id,
		expanded: options.expanded ?? false,
		isPartial: options.isPartial ?? false,
		isError: options.isError ?? false,
		executionStarted: options.executionStarted ?? true,
		invalidate: () => {},
		lastComponent: options.lastComponent,
		state: options.state ?? {},
	};
}

const passthroughTheme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
};

function callComponent(target: RuntimeTool, args: unknown, options: RenderContextOptions): Component {
	assert.ok(target.renderCall);
	return target.renderCall(args, passthroughTheme, renderContext(args, options));
}

function resultComponent(
	target: RuntimeTool,
	result: unknown,
	args: unknown,
	options: RenderContextOptions,
): Component {
	assert.ok(target.renderResult);
	return target.renderResult(
		result,
		{ expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
		passthroughTheme,
		renderContext(args, options),
	);
}

function rendered(component: Component, width = 120): string[] {
	return component.render(width).map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
}

function extensionContext(entries: unknown[] = [], notifications: string[] = [], idle = true, systemPrompt = ""): any {
	return {
		cwd: testRoot,
		getSystemPrompt: () => systemPrompt,
		model: nativeModel,
		mode: "tui",
		hasUI: true,
		sessionManager: {
			buildContextEntries: () => entries,
			getBranch: () => entries,
		},
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
		isIdle: () => idle,
		isProjectTrusted: () => true,
	};
}

const externalTools: ExternalTool[] = [
	{ name: "read", description: "Read files", source: "builtin" },
	{ name: "bash", description: "Run shell commands", source: "builtin" },
	{ name: "edit", description: "Edit files", source: "builtin" },
	{ name: "write", description: "Write files", source: "builtin" },
	{ name: "web_search", description: "Search the web", source: "npm:pi-web-access" },
	{ name: "document_parse", description: "Parse documents", source: "npm:pi-docparser" },
];

async function startHarness(options: HarnessOptions = {}) {
	const harness = createHarness(options);
	const context = () => extensionContext([], [], true, options.systemPrompt);
	await harness.emitAsync("session_start", { type: "session_start", reason: "startup" }, context());
	await harness.emitAsync("resources_discover", { type: "resources_discover", cwd: testRoot, reason: "startup" }, context());
	return harness;
}

test("registers only the standalone tool_search loader", () => {
	const harness = createHarness();
	assert.deepEqual(harness.tools.map(({ name }) => name), ["tool_search"]);
	const search = harness.tool("tool_search");
	assert.equal(search.renderShell, "self");
	assert.ok(search.renderCall);
	assert.ok(search.renderResult);
});

test("keeps base tools and the loader active while deferring other active tools", async () => {
	const harness = await startHarness({ externalTools });
	assert.deepEqual(new Set(harness.getActiveTools()), new Set(["read", "bash", "edit", "write", "tool_search"]));
	const manifest = harness.tool("tool_search").description;
	assert.match(manifest, /web_search — Search the web/);
	assert.match(manifest, /document_parse — Parse documents/);
	assert.match(manifest, /not provided upfront/);
	assert.match(manifest, /call the loaded tools directly/);
	assert.doesNotMatch(manifest, /JSON Schema|properties/i);
});

test("tools that were already inactive remain excluded from search", async () => {
	const harness = await startHarness({ externalTools, activeTools: ["read", "bash", "edit", "write", "web_search"] });
	const manifest = harness.tool("tool_search").description;
	assert.match(manifest, /web_search/);
	assert.doesNotMatch(manifest, /document_parse/);
});

test("activates exact deferred names additively without changing the manifest", async () => {
	const harness = await startHarness({ externalTools });
	const search = harness.tool("tool_search");
	assert.match(search.promptGuidelines?.[0] ?? "", /use tool_search to load it/);
	assert.match(search.promptSnippet ?? "", /by exact name from the manifest/);
	assert.ok(search.execute);
	const result = await search.execute("search-1", { tool_names: ["web_search"] });
	assert.deepEqual(result.details, {
		matches: ["web_search"],
		added: ["web_search"],
		active: ["web_search"],
		unknown: [],
		loadedKeys: ["npm:pi-web-access\u0000web_search"],
	});
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.tool("tool_search"), search);
	assert.match(harness.tool("tool_search").description, /web_search/);
	assert.match(result.content[0].text, /Tool guidance:/);
	assert.match(result.content[0].text, /- web_search: Search the web/);
	const repeat = await search.execute("search-repeat", { tool_names: ["web_search"] });
	assert.deepEqual(repeat.details.added, []);
	assert.deepEqual(repeat.details.active, ["web_search"]);
	assert.doesNotMatch(repeat.content[0].text, /Tool guidance:/);
	const typo = await search.execute("search-typo", { tool_names: ["web_seach"] });
	assert.deepEqual(typo.details.unknown, ["web_seach"]);
	assert.match(typo.content[0].text, /Did you mean: web_search/);
});

test("tool_search uses structured snippets even when the tool was already deferred", async () => {
	const harness = await startHarness({ externalTools });
	assert.equal(harness.getActiveTools().includes("web_search"), false);
	await harness.emitAsync("before_agent_start", {
		systemPromptOptions: {
			cwd: testRoot,
			toolSnippets: { web_search: "Use for web research questions. Prefer queries with varied angles." },
			toolGuidelines: { web_search: ["Use current structured guidance."] },
		},
	}, extensionContext());
	const search = harness.tool("tool_search");
	assert.ok(search.execute);
	const result = await search.execute("search-snippet", { tool_names: ["web_search"] });
	assert.match(result.content[0].text, /- web_search: Use for web research questions\. Prefer queries with varied angles\./);
	assert.doesNotMatch(result.content[0].text, /- web_search: Search the web$/m);
	assert.match(result.content[0].text, /Use current structured guidance/);
});

test("uses a compact status row and keeps full diagnostics expanded", async () => {
	const harness = await startHarness({ externalTools });
	const search = harness.tool("tool_search");
	assert.ok(search.execute);
	const args = { tool_names: ["web_search"] };
	const state: Record<string, unknown> = {};
	const before = callComponent(search, args, {
		id: "tool-search-render",
		executionStarted: false,
		isPartial: true,
		state,
	});
	assert.deepEqual(rendered(before), []);
	const active = callComponent(search, args, {
		id: "tool-search-render",
		executionStarted: true,
		isPartial: true,
		state,
		lastComponent: before,
	});
	assert.deepEqual(rendered(active), ["● Activating web_search"]);
	const result = await search.execute("tool-search-render", args);
	assert.deepEqual(rendered(resultComponent(search, result, args, { id: "tool-search-render", state })), []);
	assert.deepEqual(rendered(active), ["✓ Activated web_search"]);
	const expandedCall = callComponent(search, args, {
		id: "tool-search-render",
		expanded: true,
		state,
		lastComponent: active,
	});
	const expandedResult = resultComponent(search, result, args, {
		id: "tool-search-render",
		expanded: true,
		state,
	});
	assert.deepEqual(rendered(expandedCall), ["✓ tool_search(web_search)"]);
	assert.deepEqual(rendered(expandedResult), [
		"  ⎿ Loaded tools: web_search",
		"    Tool guidance:",
		"    - web_search: Search the web",
	]);
	for (const width of [1, 2, 3, 4]) {
		for (const line of rendered(expandedResult, width)) assert.ok(visibleWidth(line) <= width);
	}
});

test("successful loading is not rendered as an error because guidance says disabled or unavailable", async () => {
	const harness = await startHarness({ externalTools: [
		...externalTools,
		{ name: "check_disabled", description: "Inspect disabled or unavailable resources", source: "npm:fixture" },
	] });
	const search = harness.tool("tool_search");
	const args = { tool_names: ["check_disabled"] };
	const state: Record<string, unknown> = {};
	const call = callComponent(search, args, { id: "keywords", state, executionStarted: true, isPartial: true });
	const result = await search.execute!("keywords", args);
	resultComponent(search, result, args, { id: "keywords", state });
	assert.deepEqual(rendered(call), ["✓ Activated check_disabled"]);
	await harness.command("tool-search").handler("off", extensionContext());
	const disabled = await search.execute!("disabled", args);
	assert.equal(disabled.details.disabled, true);
	resultComponent(search, disabled, args, { id: "keywords", state });
	assert.match(rendered(call)[0], /^✗ Tool search mode is disabled/);
});

test("slash command restores and re-defers managed tools using the new state key", async () => {
	const harness = await startHarness({ externalTools });
	const notifications: string[] = [];
	const command = harness.command("tool-search");
	await command.handler("off", extensionContext([], notifications));
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.getActiveTools().includes("tool_search"), false);
	assert.deepEqual(harness.appendedEntries.at(-1), {
		customType: "pi-tool-search.state",
		data: { enabled: false, loaded: [] },
	});
	await command.handler("on", extensionContext([], notifications));
	assert.equal(harness.getActiveTools().includes("web_search"), false);
	assert.equal(harness.getActiveTools().includes("tool_search"), true);
	assert.match(notifications.at(-1) ?? "", /Tool search on/);
});

test("mode changes are refused while the agent is busy", async () => {
	const harness = await startHarness({ externalTools });
	const notifications: string[] = [];
	await harness.command("tool-search").handler("off", extensionContext([], notifications, false));
	assert.equal(harness.getActiveTools().includes("web_search"), false);
	assert.equal(harness.appendedEntries.length, 0);
	assert.match(notifications.at(-1) ?? "", /Wait for the current agent turn/);
});

test("before-agent enforcement re-hides deferred tools reactivated later", async () => {
	const harness = await startHarness({ externalTools });
	harness.setActiveTools([...harness.getActiveTools(), "web_search"]);
	harness.emit("before_agent_start", { type: "before_agent_start" }, extensionContext());
	assert.equal(harness.getActiveTools().includes("web_search"), false);
});

test("a tool_search collision leaves existing tools untouched", async () => {
	const notifications: string[] = [];
	const harness = createHarness({
		externalTools: [
			...externalTools,
			{ name: "tool_search", description: "Another loader", source: "npm:other-loader" },
		],
	});
	const before = harness.getActiveTools();
	await harness.emitAsync("session_start", {}, extensionContext([], notifications));
	assert.deepEqual(harness.getActiveTools(), before);
	assert.match(notifications.at(-1) ?? "", /owned by another extension/);
});

test("a dynamic loader collision restores only tools hidden by this extension", async () => {
	const harness = await startHarness({ externalTools });
	assert.equal(harness.getActiveTools().includes("web_search"), false);
	harness.addExternalTool({ name: "tool_search", description: "Replacement loader", source: "npm:replacement" });
	harness.emit("before_agent_start", {}, extensionContext());
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.getActiveTools().includes("tool_search"), true);
});

test("restores standalone session state", async () => {
	const entries = [
		{ type: "custom", customType: "pi-tool-search.state", data: { enabled: true, loaded: ["web_search"] } },
	];
	const harness = createHarness({ externalTools });
	await harness.emitAsync("session_start", { type: "session_start", reason: "resume" }, extensionContext(entries));
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.getActiveTools().includes("document_parse"), false);
});

test("ignores legacy claude-style-tools session state entries", async () => {
	const entries = [
		{ type: "custom", customType: "claude-style-tools.tool-search", data: { enabled: false, loaded: ["web_search"] } },
	];
	const harness = createHarness({ externalTools });
	await harness.emitAsync("session_start", { type: "session_start", reason: "resume" }, extensionContext(entries));
	// The legacy entry no longer disables the extension nor restores its loaded list.
	assert.equal(harness.getActiveTools().includes("web_search"), false);
	assert.equal(harness.getActiveTools().includes("tool_search"), true);
});

test("session_tree re-restores loaded and enabled state per branch", async () => {
	const harness = await startHarness({ externalTools });
	const loadedResult = (toolCallId: string, name: string) => ({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "tool_search",
			content: [{ type: "text", text: `Loaded tools: ${name}` }],
			details: { matches: [name], added: [name], active: [name], unknown: [] },
			isError: false,
		},
	});
	// Current branch: web_search activated in this session.
	await harness.tool("tool_search").execute!("load-a", { tool_names: ["web_search"] });
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.getActiveTools().includes("document_parse"), false);
	// Jump to a branch where document_parse was loaded instead: the tool
	// surface follows the new branch, and the old branch's activation hides.
	const branchB = [loadedResult("search-b", "document_parse")];
	await harness.emitAsync("session_tree", { type: "session_tree", newLeafId: "b", oldLeafId: "a" }, extensionContext(branchB));
	assert.equal(harness.getActiveTools().includes("document_parse"), true);
	assert.equal(harness.getActiveTools().includes("web_search"), false);
	assert.equal(harness.getActiveTools().includes("tool_search"), true);
	// Jump back: web_search returns, document_parse hides again.
	const branchA = [loadedResult("search-a", "web_search")];
	await harness.emitAsync("session_tree", { type: "session_tree", newLeafId: "a", oldLeafId: "b" }, extensionContext(branchA));
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.getActiveTools().includes("document_parse"), false);
	// A branch where tool-search was off restores eager mode: every deferred
	// tool active, loader hidden.
	const branchOff = [
		{ type: "custom", customType: "pi-tool-search.state", data: { enabled: false, loaded: [] } },
	];
	await harness.emitAsync("session_tree", { type: "session_tree", newLeafId: "c", oldLeafId: "a" }, extensionContext(branchOff));
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.getActiveTools().includes("document_parse"), true);
	assert.equal(harness.getActiveTools().includes("tool_search"), false);
	// And back to deferred mode with only the branch's own activation.
	await harness.emitAsync("session_tree", { type: "session_tree", newLeafId: "a2", oldLeafId: "c" }, extensionContext(branchA));
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.getActiveTools().includes("document_parse"), false);
	assert.equal(harness.getActiveTools().includes("tool_search"), true);
});

test("restores matched tools that were already active during loading", async () => {
	const entries = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "search-already-active",
				toolName: "tool_search",
				content: [{ type: "text", text: "Already active: web_search" }],
				details: { matches: ["web_search"], added: [], active: ["web_search"], unknown: [] },
				isError: false,
			},
		},
	];
	const harness = createHarness({ externalTools });
	await harness.emitAsync("session_start", { type: "session_start", reason: "resume" }, extensionContext(entries));
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.getActiveTools().includes("document_parse"), false);
});

test("restores tools loaded from historical tool results", async () => {
	const entries = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "search-old",
				toolName: "tool_search",
				content: [{ type: "text", text: "Loaded tools: web_search" }],
				addedToolNames: ["web_search"],
				isError: false,
			},
		},
	];
	const harness = createHarness({ externalTools });
	await harness.emitAsync("session_start", { type: "session_start", reason: "resume" }, extensionContext(entries));
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.getActiveTools().includes("document_parse"), false);
});

test("explicit allowlist registry refresh does not leak unrequested tools during normal loading", async () => {
	const harness = await startHarness({ externalTools, refreshActivatesAllowlist: true });
	const search = harness.tool("tool_search");
	await search.execute!("load", { tool_names: ["web_search"] });
	assert.equal(harness.getActiveTools().includes("document_parse"), false);
	assert.equal(harness.tool("tool_search"), search);
});

test("turn_end reasserts the deferred subset after another extension registers a tool", async () => {
	const harness = await startHarness({ externalTools, refreshActivatesAllowlist: true });
	await harness.tool("tool_search").execute!("load", { tool_names: ["web_search"] });
	harness.addExternalTool({ name: "late_tool", description: "Late", source: "npm:late" });
	assert.equal(harness.getActiveTools().includes("document_parse"), true);
	await harness.emitAsync("turn_end", { toolResults: [] }, extensionContext());
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.getActiveTools().includes("document_parse"), false);
	assert.equal(harness.getActiveTools().includes("late_tool"), false);
});

test("model capability changes preserve loaded tools and leave other tools deferred", async () => {
	const harness = await startHarness({ externalTools });
	await harness.tool("tool_search").execute!("load", { tool_names: ["web_search"] });
	const active = harness.getActiveTools();
	const notifications: string[] = [];
	await harness.emitAsync("model_select", { model: { api: "openai-responses" } }, extensionContext());
	assert.deepEqual(harness.getActiveTools(), active);
	await harness.command("tool-search").handler("status", extensionContext([], notifications));
	assert.match(notifications.at(-1)!, /on · portable/);
	await harness.emitAsync("model_select", { model: nativeModel }, extensionContext());
	assert.deepEqual(harness.getActiveTools(), active);
	await harness.command("tool-search").handler("status", extensionContext([], notifications));
	assert.match(notifications.at(-1)!, /on · native/);
});

for (const api of ["openai-responses", "openai-completions", "anthropic-messages", "google-generative-ai"]) {
	test(`${api} without native flags uses additive portable loading and survives registry refresh`, async () => {
		const context = { ...extensionContext(), model: { api } };
		const harness = createHarness({ externalTools, refreshActivatesAllowlist: true });
		await harness.emitAsync("session_start", {}, context);
		assert.equal(harness.getActiveTools().includes("web_search"), false);
		assert.equal(harness.getActiveTools().includes("tool_search"), true);
		const loader = harness.tool("tool_search");
		const metadata = await harness.emitAsync("before_agent_start", {}, context);
		await loader.execute!("load", { tool_names: ["web_search"] });
		harness.addExternalTool({ name: "late_tool", description: "Late", source: "npm:late" });
		await harness.emitAsync("turn_end", { toolResults: [] }, context);
		assert.equal(harness.getActiveTools().includes("web_search"), true);
		assert.equal(harness.getActiveTools().includes("document_parse"), false);
		assert.equal(harness.getActiveTools().includes("late_tool"), false);
		const repeated = await harness.tool("tool_search").execute!("again", { tool_names: ["web_search"] });
		assert.deepEqual(repeated.details.added, []);
		assert.deepEqual(await harness.emitAsync("before_agent_start", {}, context), metadata);
	});
}

test("explicit eager restores allowed tools, respects exclusions and stays eager after on", async () => {
	const cwd = mkdtempSync(join(testRoot, "eager-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi/pi-tool-search.json"), JSON.stringify({ version: 1, mode: "eager", tools: [
		{ name: "document_parse", source: "npm:pi-docparser", policy: "excluded" },
	] }));
	for (const model of [nativeModel, { api: "openai-completions" }]) {
		const notifications: string[] = [];
		const context = { ...extensionContext([], notifications), cwd, model };
		const harness = createHarness({ externalTools });
		await harness.emitAsync("session_start", {}, context);
		await harness.command("tool-search").handler("on", context);
		assert.equal(harness.getActiveTools().includes("web_search"), true);
		assert.equal(harness.getActiveTools().includes("document_parse"), false);
		assert.equal(harness.getActiveTools().includes("tool_search"), false);
		assert.match(notifications.at(-1)!, /eager.*explicit setting/);
	}
});

test("portable mode off and on restore allowed tools and reset loaded state", async () => {
	const context = { ...extensionContext(), model: { api: "openai-completions" } };
	const harness = createHarness({ externalTools });
	await harness.emitAsync("session_start", {}, context);
	await harness.tool("tool_search").execute!("load", { tool_names: ["web_search"] });
	await harness.command("tool-search").handler("off", context);
	assert.equal(harness.getActiveTools().includes("document_parse"), true);
	assert.equal(harness.getActiveTools().includes("tool_search"), false);
	await harness.command("tool-search").handler("on", context);
	assert.equal(harness.getActiveTools().includes("web_search"), false);
	assert.equal(harness.getActiveTools().includes("document_parse"), false);
	assert.equal(harness.getActiveTools().includes("tool_search"), true);
});

test("custom prefix status and tool metadata follow the current prompt without modifying its role", async () => {
	const harness = await startHarness({ externalTools });
	const notifications: string[] = [];
	const context = extensionContext([], notifications);
	const cases = [
		{ prefix: "Custom safety instructions", deferred: true },
		{ prefix: undefined, deferred: true },
		{ prefix: "Role\n<tools>Parent tool metadata</tools>", deferred: true },
		{ prefix: "Role", deferred: false, sections: { tools: "Authored tool section" } },
		{ prefix: "Role", deferred: false, forceSystemPrompt: "" },
		{ prefix: "Another custom role", deferred: true },
	];
	for (const { prefix, deferred, sections, forceSystemPrompt } of cases) {
		const options = { cwd: testRoot, customPrompt: prefix, sections, forceSystemPrompt };
		const results = await harness.emitAsync("before_agent_start", { systemPromptOptions: options }, context);
		assert.deepEqual(results, [undefined]);
		assert.equal(options.customPrompt, prefix);
		assert.equal(harness.getActiveTools().includes("tool_search"), deferred);
		assert.equal(harness.getActiveTools().includes("web_search"), !deferred);
		await harness.command("tool-search").handler("status", context);
		const status = notifications.at(-1)!;
		assert.equal(status.includes("custom prefix"), deferred && !!prefix);
		assert.match(status, deferred ? /Tool search on/ : /eager.*forced prompt or authored tools\/rules section/);
	}
});

test("child policy is loaded from ctx.cwd rather than the factory process cwd", async () => {
	const cwd = mkdtempSync(join(testRoot, "child-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi/pi-tool-search.json"), JSON.stringify({ version: 1, tools: [{ name: "web_search", source: "npm:pi-web-access", policy: "excluded" }] }));
	const harness = createHarness({ externalTools });
	await harness.emitAsync("session_start", {}, { ...extensionContext(), cwd });
	assert.doesNotMatch(harness.tool("tool_search").description, /web_search/);
	assert.match(harness.tool("tool_search").description, /document_parse/);
});

test("a replacement provider does not inherit an earlier provider's activation", async () => {
	const harness = await startHarness({ externalTools });
	await harness.tool("tool_search").execute!("load", { tool_names: ["web_search"] });
	harness.addExternalTool({ name: "web_search", description: "Replacement", source: "npm:different-provider" });
	await harness.emitAsync("turn_end", { toolResults: [] }, extensionContext());
	assert.equal(harness.getActiveTools().includes("web_search"), false);
});

test("resume prefers structured activation intent over inflated wrapper additions", async () => {
	const harness = createHarness({ externalTools });
	const entries = [{ type: "message", message: {
		role: "toolResult", toolName: "tool_search", toolCallId: "old", content: [], isError: false,
		addedToolNames: ["web_search", "document_parse"], details: { added: ["web_search"], active: ["web_search"] },
	} }];
	await harness.emitAsync("session_start", {}, extensionContext(entries));
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.getActiveTools().includes("document_parse"), false);
});

async function configurationHarness(options: {
	global?: ToolPolicyRecord[];
	project?: ToolPolicyRecord[];
	externalTools?: ExternalTool[];
	trusted?: boolean;
} = {}) {
	const root = mkdtempSync(join(testRoot, "config-command-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const globalPath = join(agentDir, "pi-tool-search.json");
	const projectPath = join(cwd, ".pi", "pi-tool-search.json");
	writeFileSync(globalPath, JSON.stringify({ version: 1, tools: options.global ?? [] }));
	writeFileSync(projectPath, JSON.stringify({ version: 1, tools: options.project ?? [] }));
	let selected = new Map<string, ToolPolicy>();
	const notifications: string[] = [];
	const context = {
		...extensionContext([], notifications),
		cwd,
		isProjectTrusted: () => options.trusted ?? true,
		ui: {
			notify: (text: string) => notifications.push(text),
			custom: async () => new Map(selected),
		},
	};
	const harness = createHarness({ agentDir, externalTools: options.externalTools ?? externalTools });
	await harness.emitAsync("session_start", {}, context);
	return {
		harness, context, notifications, agentDir, cwd, globalPath, projectPath,
		select(records: ToolPolicyRecord[]) {
			selected = new Map(records.map((record) => [policyRecordKey(record), record.policy]));
		},
		globalRecords: () => JSON.parse(readFileSync(globalPath, "utf8")).tools as ToolPolicyRecord[],
	};
}

const webPolicy = (policy: ToolPolicy): ToolPolicyRecord => ({ name: "web_search", source: "npm:pi-web-access", policy });
const documentPolicy = (policy: ToolPolicy): ToolPolicyRecord => ({ name: "document_parse", source: "npm:pi-docparser", policy });

test("closing config without edits does not write files, promote project values or reset loaded state", async () => {
	const fixture = await configurationHarness({
		global: [webPolicy("excluded"), { name: "absent", source: "npm:absent", policy: "excluded" }],
		project: [webPolicy("deferred")],
	});
	await fixture.harness.tool("tool_search").execute!("load", { tool_names: ["web_search"] });
	const before = readFileSync(fixture.globalPath, "utf8");
	fixture.select([webPolicy("deferred"), documentPolicy("deferred")]);
	await fixture.harness.command("tool-search").handler("config", fixture.context);
	assert.equal(readFileSync(fixture.globalPath, "utf8"), before);
	assert.equal(fixture.harness.getActiveTools().includes("web_search"), true);
	assert.equal(fixture.harness.appendedEntries.length, 0);
	assert.match(fixture.notifications.at(-1)!, /No tool policy changes/);
	// A no-op does not create a missing target either.
	rmSync(fixture.globalPath);
	await fixture.harness.command("tool-search").handler("config", fixture.context);
	assert.equal(existsSync(fixture.globalPath), false);
});

test("global command saves only edits while retaining absent providers and project-specific values", async () => {
	const absent: ToolPolicyRecord = { name: "absent", source: "npm:absent", policy: "excluded" };
	const fixture = await configurationHarness({ global: [webPolicy("excluded"), absent], project: [webPolicy("always")] });
	const projectBefore = readFileSync(fixture.projectPath, "utf8");
	fixture.select([webPolicy("always"), documentPolicy("always")]);
	await fixture.harness.command("tool-search").handler("config", fixture.context);
	assert.deepEqual(fixture.globalRecords(), [webPolicy("excluded"), absent, documentPolicy("always")]);
	assert.equal(readFileSync(fixture.projectPath, "utf8"), projectBefore);
	assert.equal(fixture.harness.getActiveTools().includes("web_search"), true);
	assert.equal(fixture.harness.getActiveTools().includes("document_parse"), true);
	assert.match(fixture.notifications.at(-1)!, /Saved 1 tool policy change/);
});

test("a stale session saving another row does not undo a newer global edit", async () => {
	const fixture = await configurationHarness();
	const second = createHarness({ agentDir: fixture.agentDir, externalTools });
	await second.emitAsync("session_start", {}, fixture.context);
	fixture.select([webPolicy("excluded"), documentPolicy("deferred")]);
	await fixture.harness.command("tool-search").handler("config", fixture.context);
	// The second panel still has its original effective web_search=deferred.
	fixture.select([webPolicy("deferred"), documentPolicy("always")]);
	await second.command("tool-search").handler("config", fixture.context);
	assert.deepEqual(fixture.globalRecords(), [webPolicy("excluded"), documentPolicy("always")]);
	assert.equal(second.getActiveTools().includes("web_search"), false);
});

test("masked global edits keep deferred tools loaded and persist their activation", async () => {
	for (const policy of ["always", "excluded"] as const) {
		const fixture = await configurationHarness({ project: [webPolicy("deferred")] });
		await fixture.harness.tool("tool_search").execute!("load", { tool_names: ["web_search"] });
		fixture.select([webPolicy(policy)]);
		await fixture.harness.command("tool-search").handler("config", fixture.context);
		assert.deepEqual(fixture.globalRecords(), [webPolicy(policy)]);
		assert.equal(fixture.harness.getActiveTools().includes("web_search"), true);
		assert.match(fixture.notifications.at(-1)!, /overridden by project-level/);
		const state = fixture.harness.appendedEntries.at(-1)!;
		assert.deepEqual((state.data as any).loaded, ["web_search"]);
		const resumed = createHarness({ agentDir: fixture.agentDir, externalTools });
		await resumed.emitAsync("session_start", {}, {
			...fixture.context,
			sessionManager: {
				getBranch: () => [{ type: "custom", ...state }],
				buildContextEntries: () => [{ type: "custom", ...state }],
			},
		});
		assert.equal(resumed.getActiveTools().includes("web_search"), true);
	}
});

test("an effective policy change still unloads a previously deferred tool", async () => {
	const fixture = await configurationHarness();
	await fixture.harness.tool("tool_search").execute!("load", { tool_names: ["web_search"] });
	fixture.select([webPolicy("excluded")]);
	await fixture.harness.command("tool-search").handler("config", fixture.context);
	assert.equal(fixture.harness.getActiveTools().includes("web_search"), false);
	assert.deepEqual((fixture.harness.appendedEntries.at(-1)!.data as any).loaded, []);
});

test("project saves preserve missing-provider records without modifying the global layer", async () => {
	const late: ToolPolicyRecord = { name: "late_tool", source: "npm:late", policy: "always" };
	const fixture = await configurationHarness({ project: [late] });
	const globalBefore = readFileSync(fixture.globalPath, "utf8");
	fixture.select([webPolicy("always")]);
	await fixture.harness.command("tool-search").handler("config project", fixture.context);
	assert.deepEqual(JSON.parse(readFileSync(fixture.projectPath, "utf8")).tools, [late, webPolicy("always")]);
	assert.equal(readFileSync(fixture.globalPath, "utf8"), globalBefore);
	fixture.harness.addExternalTool({ name: "late_tool", source: "npm:late", description: "Late" });
	await fixture.harness.emitAsync("turn_end", { toolResults: [] }, fixture.context);
	assert.equal(fixture.harness.getActiveTools().includes("late_tool"), true);
});

test("project saves do not retain a deleted project record in the global fallback", async () => {
	const late: ToolPolicyRecord = { name: "late_tool", source: "npm:late", policy: "excluded" };
	const fixture = await configurationHarness({ global: [late], project: [{ ...late, policy: "always" }] });
	// An external editor removes the project record before this save merges its edits.
	writeFileSync(fixture.projectPath, JSON.stringify({ version: 1, tools: [] }));
	fixture.select([webPolicy("always")]);
	await fixture.harness.command("tool-search").handler("config project", fixture.context);
	fixture.harness.addExternalTool({ name: "late_tool", source: "npm:late", description: "Late" });
	await fixture.harness.emitAsync("turn_end", { toolResults: [] }, fixture.context);
	assert.equal(fixture.harness.getActiveTools().includes("late_tool"), false);
	assert.doesNotMatch(fixture.harness.tool("tool_search").description, /late_tool/);
});

test("failed command saves preserve the existing file, catalog and activation state", async () => {
	const fixture = await configurationHarness();
	const original = JSON.stringify({ version: 2, mode: "eager", tools: [webPolicy("excluded")] });
	writeFileSync(fixture.globalPath, original);
	fixture.select([webPolicy("always")]);
	await fixture.harness.command("tool-search").handler("config", fixture.context);
	assert.equal(readFileSync(fixture.globalPath, "utf8"), original);
	assert.equal(fixture.harness.getActiveTools().includes("web_search"), false);
	assert.match(fixture.harness.tool("tool_search").description, /web_search/);
	assert.equal(fixture.harness.appendedEntries.length, 0);
	assert.match(fixture.notifications.at(-1)!, /Failed to save.*Refusing to overwrite/);
});

test("project commands require trust while global commands ignore untrusted project overrides", async () => {
	const fixture = await configurationHarness({ global: [webPolicy("excluded")], project: [webPolicy("always")], trusted: false });
	const projectBefore = readFileSync(fixture.projectPath, "utf8");
	fixture.select([documentPolicy("always")]);
	await fixture.harness.command("tool-search").handler("config project", fixture.context);
	assert.match(fixture.notifications.at(-1)!, /until this project is trusted/);
	await fixture.harness.command("tool-search").handler("config", fixture.context);
	assert.deepEqual(fixture.globalRecords(), [webPolicy("excluded"), documentPolicy("always")]);
	assert.equal(fixture.harness.getActiveTools().includes("web_search"), false);
	assert.equal(readFileSync(fixture.projectPath, "utf8"), projectBefore);
});

test("a session becoming busy while the panel is open prevents a config save", async () => {
	const fixture = await configurationHarness();
	const before = readFileSync(fixture.globalPath, "utf8");
	fixture.context.ui.custom = async () => {
		fixture.context.isIdle = () => false;
		return new Map([[policyRecordKey(webPolicy("always")), "always" as const]]);
	};
	await fixture.harness.command("tool-search").handler("config", fixture.context);
	assert.equal(readFileSync(fixture.globalPath, "utf8"), before);
	assert.equal(fixture.harness.appendedEntries.length, 0);
	assert.match(fixture.notifications.at(-1)!, /session must be idle/);
});

test("project trust is checked again after the panel closes", async () => {
	const fixture = await configurationHarness();
	const before = readFileSync(fixture.projectPath, "utf8");
	fixture.context.ui.custom = async () => {
		fixture.context.isProjectTrusted = () => false;
		return new Map([[policyRecordKey(webPolicy("always")), "always" as const]]);
	};
	await fixture.harness.command("tool-search").handler("config project", fixture.context);
	assert.equal(readFileSync(fixture.projectPath, "utf8"), before);
	assert.equal(fixture.harness.appendedEntries.length, 0);
	assert.match(fixture.notifications.at(-1)!, /project saves require trust/);
});

test("skipped policy edits do not change activation or masquerade as project overrides", async () => {
	const name = "bad\u0000name";
	const fixture = await configurationHarness({ externalTools: [...externalTools, { name, source: "npm:fixture", description: "Invalid name" }] });
	const before = readFileSync(fixture.globalPath, "utf8");
	fixture.select([{ name, source: "npm:fixture", policy: "always" }]);
	await fixture.harness.command("tool-search").handler("config", fixture.context);
	assert.equal(readFileSync(fixture.globalPath, "utf8"), before);
	assert.equal(fixture.harness.getActiveTools().includes(name), false);
	assert.match(fixture.notifications.at(-1)!, /not saved or applied/);
	assert.ok(!fixture.notifications.some((message) => message.includes("overridden by project")));
});

test("symlinked loader metadata does not trigger a false collision", async () => {
	const cwd = mkdtempSync(join(testRoot, "linked-loader-"));
	const linked = join(cwd, "entry.ts");
	symlinkSync(resolve("src/index.ts"), linked);
	const harness = createHarness({ externalTools, loaderPath: linked });
	const notifications: string[] = [];
	await harness.emitAsync("session_start", {}, { ...extensionContext([], notifications), cwd });
	assert.equal(harness.getActiveTools().includes("web_search"), false);
	assert.equal(harness.getActiveTools().includes("tool_search"), true);
	assert.ok(!notifications.some((text) => text.includes("owned by another extension")));
});

test("relative provider policies load and save using ctx.cwd rather than process.cwd", async () => {
	const relativeTool = { name: "relative_tool", source: "cli", path: "./provider.ts", description: "Relative provider" };
	const fixture = await configurationHarness({ externalTools: [...externalTools, relativeTool] });
	const record: ToolPolicyRecord = { name: relativeTool.name, source: `file:${join(fixture.cwd, "provider.ts")}`, policy: "excluded" };
	writeFileSync(fixture.globalPath, JSON.stringify({ version: 1, tools: [record] }));
	await fixture.harness.emitAsync("session_start", {}, fixture.context);
	assert.doesNotMatch(fixture.harness.tool("tool_search").description, /relative_tool/);
	fixture.select([{ ...record, policy: "always" }]);
	await fixture.harness.command("tool-search").handler("config", fixture.context);
	assert.deepEqual(fixture.globalRecords(), [{ ...record, policy: "always" }]);
	assert.equal(fixture.harness.getActiveTools().includes("relative_tool"), true);
});

test("request auditing is disabled by default and does not even access the payload", async () => {
	const harness = await startHarness({ externalTools });
	await harness.emitAsync("before_provider_request", { get payload() { throw new Error("Audit should not inspect payload"); } }, extensionContext());
	const notifications: string[] = [];
	await harness.command("tool-search").handler("audit status", extensionContext([], notifications));
	assert.match(notifications[0], /off: no requests observed/);
});

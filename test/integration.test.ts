import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";

const testRoot = mkdtempSync(`${tmpdir()}/pi-tool-search-lifecycle-`);
process.env.PI_CODING_AGENT_DIR = testRoot;
after(() => rmSync(testRoot, { recursive: true, force: true }));
const nativeModel = { api: "openai-responses", compat: { supportsAdditionalTools: true } };
const prompt = "Role\n\nAvailable tools:\n- read: Read files\n\nIn addition to the tools above, more tools.\n\nGuidelines:\n- Be concise in your responses\n\nPi documentation (help)\nContext";
function completeEvent(event: string, args: unknown[]): unknown[] {
	if (event !== "before_agent_start") return args;
	return [{ systemPrompt: prompt, systemPromptOptions: { cwd: testRoot, toolSnippets: { read: "Read files" } }, ...(args[0] as object) }, ...args.slice(1)];
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
	externalTools?: ExternalTool[];
	activeTools?: string[];
	refreshActivatesAllowlist?: boolean;
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
						path: resolve("src/index.ts"),
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
	extension(pi);
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

function extensionContext(entries: unknown[] = [], notifications: string[] = [], idle = true): any {
	return {
		cwd: testRoot,
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
	await harness.emitAsync("session_start", { type: "session_start", reason: "startup" }, extensionContext());
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
	const repeat = await search.execute("search-repeat", { tool_names: ["web_search"] });
	assert.deepEqual(repeat.details.added, []);
	assert.deepEqual(repeat.details.active, ["web_search"]);
	const typo = await search.execute("search-typo", { tool_names: ["web_seach"] });
	assert.deepEqual(typo.details.unknown, ["web_seach"]);
	assert.match(typo.content[0].text, /Did you mean: web_search/);
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
	assert.deepEqual(rendered(expandedResult), ["  ⎿ Loaded tools: web_search"]);
	for (const width of [1, 2, 3, 4]) {
		for (const line of rendered(expandedResult, width)) assert.ok(visibleWidth(line) <= width);
	}
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

test("restores both legacy and standalone session state", async () => {
	for (const customType of ["claude-style-tools.tool-search", "pi-tool-search.state"]) {
		const entries = [
			{ type: "custom", customType, data: { enabled: true, loaded: ["web_search"] } },
		];
		const harness = createHarness({ externalTools });
		await harness.emitAsync("session_start", { type: "session_start", reason: "resume" }, extensionContext(entries));
		assert.equal(harness.getActiveTools().includes("web_search"), true);
		assert.equal(harness.getActiveTools().includes("document_parse"), false);
	}
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

test("model capability changes select a fixed allowed surface and can return to deferred mode", async () => {
	const harness = await startHarness({ externalTools });
	await harness.emitAsync("model_select", { model: { api: "openai-responses" } }, extensionContext());
	assert.equal(harness.getActiveTools().includes("web_search"), true);
	assert.equal(harness.getActiveTools().includes("tool_search"), false);
	await harness.emitAsync("model_select", { model: nativeModel }, extensionContext());
	assert.equal(harness.getActiveTools().includes("web_search"), false);
	assert.equal(harness.getActiveTools().includes("tool_search"), true);
});

test("unrecognized prompt falls back without modifying the supplied role", async () => {
	const harness = await startHarness({ externalTools });
	const results = await harness.emitAsync("before_agent_start", { systemPrompt: "Custom safety instructions" }, extensionContext());
	assert.deepEqual(results, [undefined]);
	assert.equal(harness.getActiveTools().includes("tool_search"), false);
	assert.equal(harness.getActiveTools().includes("web_search"), true);
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

test("request auditing is disabled by default and does not even access the payload", async () => {
	const harness = await startHarness({ externalTools });
	await harness.emitAsync("before_provider_request", { get payload() { throw new Error("Audit should not inspect payload"); } }, extensionContext());
	const notifications: string[] = [];
	await harness.command("tool-search").handler("audit status", extensionContext([], notifications));
	assert.match(notifications[0], /off: no requests observed/);
});

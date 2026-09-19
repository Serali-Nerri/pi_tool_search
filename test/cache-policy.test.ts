import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ContextEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RequestAudit } from "../src/audit.ts";
import { supportsIncrementalTools } from "../src/capabilities.ts";
import { loadEffectiveToolSearchPolicies, loadToolSearchPolicies, saveToolSearchPolicies } from "../src/config.ts";
import { ActivationHistory } from "../src/history.ts";
import { hasStandardToolMetadata, stabilizeToolMetadata } from "../src/prompt.ts";
import { PROTECTED_TOOL_NAMES, ToolCatalog, isOwnedBy, normalizeExtensionPath, toolKey, type ToolCatalogEntry } from "../src/registry.ts";

function tool(name: string, source = "npm:test", path = "/tmp/providers/test/index.ts"): ToolInfo {
	return { name, description: `${name} description`, parameters: Type.Object({}), promptGuidelines: [`${name} guideline`], sourceInfo: { source, path, scope: "user", origin: "package" } };
}
function entry(name: string, policy: ToolCatalogEntry["policy"]): ToolCatalogEntry {
	const value = tool(name);
	return { key: toolKey(value), tool: value, policy, protected: false };
}
function prompt(tools: string[], guides: string[], tail = "Current project safety instructions") {
	return `Coding role\n\nAvailable tools:\n${tools.map((name) => `- ${name}: ${name} snippet`).join("\n")}\n\nIn addition to the tools above, custom tools may exist.\n\nGuidelines:\n${guides.map((guide) => `- ${guide}`).join("\n")}\n\nPi documentation (help)\n${tail}`;
}

test("capabilities use declared resolved-model protocol flags, never model-name guesses", () => {
	assert.equal(supportsIncrementalTools(undefined), false);
	assert.equal(supportsIncrementalTools({ api: "openai-responses" }), false);
	assert.equal(supportsIncrementalTools({ api: "openai-completions", compat: { supportsAdditionalTools: true } }), false);
	assert.equal(supportsIncrementalTools({ api: "openai-codex-responses", compat: { supportsAdditionalTools: true } }), true);
	assert.equal(supportsIncrementalTools({ api: "openai-responses", compat: { supportsToolSearch: true } }), true);
	assert.equal(supportsIncrementalTools({ api: "openai-responses", compat: { supportsToolSearch: "true" } }), false);
	assert.equal(supportsIncrementalTools({ api: "anthropic-messages", compat: { supportsToolReferences: true } }), true);
	assert.equal(supportsIncrementalTools({ api: "anthropic-messages" }), false);
	assert.equal(supportsIncrementalTools({ api: "openai-responses", compat: { supportsToolReferences: true } }), false);
});

test("locked defaults apply only to registered tools and ignore saved exclusions", () => {
	const catalog = new ToolCatalog();
	const tools = [...PROTECTED_TOOL_NAMES].map((name) => tool(name));
	catalog.refresh(tools, new Set(), new Map(tools.map((value) => [toolKey(value), "excluded"])));
	assert.ok(catalog.all().every((value) => value.policy === "always" && value.protected));
	catalog.refresh(tools.filter((value) => ["read", "tool_search"].includes(value.name)), new Set(), new Map());
	assert.equal(catalog.byName("write"), undefined);
});

test("named defaults stay user-configurable: grep/find/ls always, powershell excluded, nothing locked", () => {
	const catalog = new ToolCatalog();
	const tools = ["grep", "find", "ls", "powershell"].map((name) => tool(name));
	catalog.refresh(tools, new Set(), new Map());
	assert.ok(["grep", "find", "ls"].every((name) => catalog.byName(name)?.policy === "always"));
	assert.equal(catalog.byName("powershell")?.policy, "excluded");
	assert.ok(catalog.all().every((value) => !value.protected));
	const overrides = new Map(tools.map((value) => [toolKey(value), "deferred" as const]));
	catalog.refresh(tools, new Set(), overrides);
	assert.ok(catalog.all().every((value) => value.policy === "deferred"));
});

test("ordinary tools follow the generic defaults and never lock", () => {
	const wait = tool("helper", "npm:example");
	const catalog = new ToolCatalog();
	catalog.refresh([wait], new Set(["helper"]), new Map());
	assert.equal(catalog.byName("helper")?.policy, "deferred");
	assert.equal(catalog.byName("helper")?.protected, false);
	// Registered but not initially active: excluded by default.
	const inactive = new ToolCatalog();
	inactive.refresh([wait], new Set(), new Map());
	assert.equal(inactive.byName("helper")?.policy, "excluded");
	for (const policy of ["always", "excluded", "deferred"] as const) {
		catalog.refresh([wait], new Set(["helper"]), new Map([[toolKey(wait), policy]]));
		assert.equal(catalog.byName("helper")?.policy, policy);
	}
	const agentCatalog = new ToolCatalog();
	const agent = tool("Agent", "auto");
	agentCatalog.refresh([agent], new Set([agent.name]), new Map());
	assert.equal(agentCatalog.byName("Agent")?.policy, "deferred");
	assert.equal(agentCatalog.byName("Agent")?.protected, false);
	agentCatalog.refresh([agent], new Set(), new Map([[toolKey(agent), "always"]]));
	assert.equal(agentCatalog.byName("Agent")?.policy, "always");
	assert.equal(agentCatalog.byName("Agent")?.protected, false);
	const control = tool("control_hook", "npm:example");
	agentCatalog.refresh([control], new Set([control.name]), new Map());
	assert.equal(agentCatalog.byName("control_hook")?.policy, "deferred");
	assert.equal(agentCatalog.byName("control_hook")?.protected, false);
});

test("npm and explicit child paths share identity, while distinct local providers do not", () => {
	const path = "/tmp/agent/npm/node_modules/@ff-labs/pi-fff/src/index.ts";
	assert.equal(toolKey(tool("grep", "npm:@ff-labs/pi-fff", path)), toolKey(tool("grep", "cli", path)));
	assert.notEqual(toolKey(tool("search", "cli", "/tmp/a.ts")), toolKey(tool("search", "cli", "/tmp/b.ts")));
});

test("catalog detects schema and prompt-guideline changes even when description is unchanged", () => {
	const catalog = new ToolCatalog();
	const value = tool("a");
	assert.equal(catalog.refresh([value], new Set(["a"]), new Map()), true);
	assert.equal(catalog.refresh([value], new Set(["a"]), new Map()), false);
	value.parameters = Type.Object({ changed: Type.String() });
	assert.equal(catalog.refresh([value], new Set(["a"]), new Map()), true);
	value.promptGuidelines = ["new guideline"];
	assert.equal(catalog.refresh([value], new Set(["a"]), new Map()), true);
	assert.equal(catalog.refresh([value], new Set(["a"]), new Map()), false);
});

test("policy changes applied in memory do not cause a spurious catalog change", () => {
	const catalog = new ToolCatalog();
	const value = tool("a");
	assert.equal(catalog.refresh([value], new Set(["a"]), new Map()), true);
	assert.equal(catalog.refresh([value], new Set(["a"]), new Map()), false);
	catalog.applyPolicies(new Map([[toolKey(value), "always"]]));
	assert.equal(catalog.byName("a")?.policy, "always");
	// The signature snapshot must follow the in-memory edit, or the next
	// lifecycle refresh would report a change that never happened.
	assert.equal(catalog.refresh([value], new Set(["a"]), new Map()), false);
});

test("saved document policies do not create tools when the provider is absent or removed", () => {
	const catalog = new ToolCatalog();
	const parse = tool("document_parse", "npm:pi-docparser");
	const read = tool("read", "builtin");
	const policies = new Map([[toolKey(parse), "deferred" as const]]);
	catalog.refresh([read], new Set(["read"]), policies);
	assert.equal(catalog.byName("document_parse"), undefined);
	assert.equal(catalog.withPolicy("deferred").length, 0);
	catalog.refresh([read, parse], new Set(["read"]), policies);
	assert.equal(catalog.byName("document_parse")?.policy, "deferred");
	catalog.refresh([read], new Set(["read"]), policies);
	assert.equal(catalog.byName("document_parse"), undefined);
	assert.equal(catalog.withPolicy("deferred").length, 0);
});

test("global defaults and trusted project overrides retain precedence", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-policy-layers-"));
	try {
		const agentDir = join(root, "agent");
		const cwd = join(root, "child");
		await mkdir(agentDir);
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(join(agentDir, "pi-tool-search.json"), JSON.stringify({ version: 1, mode: "eager", audit: true, tools: [{ name: "alpha", source: "npm:fixture", policy: "always" }] }));
		await writeFile(join(cwd, ".pi/pi-tool-search.json"), JSON.stringify({ version: 1, mode: "auto", audit: false, tools: [{ name: "alpha", source: "npm:fixture", policy: "deferred" }] }));
		const trusted = await loadEffectiveToolSearchPolicies(cwd, true, agentDir);
		assert.equal(trusted.mode, "auto");
		assert.equal(trusted.audit, false);
		const catalog = new ToolCatalog();
		const value = tool("alpha", "cli", "/tmp/node_modules/fixture/index.ts");
		catalog.refresh([value], new Set(), trusted.policies, trusted.projectPolicies);
		assert.equal(catalog.byName("alpha")?.policy, "deferred");
		const untrusted = await loadEffectiveToolSearchPolicies(cwd, false, agentDir);
		assert.equal(untrusted.mode, "eager");
		assert.equal(untrusted.audit, true);
		catalog.refresh([value], new Set(), untrusted.policies, untrusted.projectPolicies);
		assert.equal(catalog.byName("alpha")?.policy, "always");
		await saveToolSearchPolicies(cwd, []);
		const saved = JSON.parse(await readFile(join(cwd, ".pi/pi-tool-search.json"), "utf8"));
		assert.equal(saved.mode, "auto");
		assert.equal(saved.audit, false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("stable metadata never injects deferred guidelines into the system prompt", () => {
	const entries = [entry("read", "always"), entry("alpha", "deferred"), entry("hidden", "excluded")];
	const options = { cwd: "/tmp", toolSnippets: { read: "read snippet", alpha: "alpha snippet", hidden: "hidden snippet" } };
	const initial = prompt(["read"], ["read guideline", "Be concise in your responses"]);
	const after = prompt(["read", "alpha"], ["read guideline", "alpha guideline", "Be concise in your responses"]);
	const stable = stabilizeToolMetadata(initial, options, entries, true, options)!;
	// Activation must not rewrite the system prompt: deferred guides travel with
	// the tool_search result instead (see buildToolGuidance in tool.ts).
	assert.equal(stable, stabilizeToolMetadata(after, options, entries, true, options));
	assert.doesNotMatch(stable, /alpha guideline/);
	assert.doesNotMatch(stable, /- alpha:|hidden/);
	assert.match(stable, /Current project safety instructions/);
});

test("multiline guidelines are removed as whole blocks, never leaked or duplicated", () => {
	const multiline = "Use alpha\n  with context";
	const alpha = tool("alpha");
	alpha.promptGuidelines = [multiline];
	const readEntry: ToolCatalogEntry = { key: toolKey(tool("read")), tool: tool("read"), policy: "always", protected: false };
	const alphaEntry: ToolCatalogEntry = { key: toolKey(alpha), tool: alpha, policy: "deferred", protected: false };
	const options = { cwd: "/tmp", toolSnippets: { read: "read snippet", alpha: "alpha snippet" } };
	// Pi renders a multiline guideline verbatim; the continuation line carries no bullet.
	const text = prompt(["read", "alpha"], ["read guideline", multiline, "Be concise"]);
	// Deferred: the whole block must vanish, including its continuation line.
	const deferred = stabilizeToolMetadata(text, options, [readEntry, alphaEntry], true, options)!;
	assert.doesNotMatch(deferred, /Use alpha/);
	assert.doesNotMatch(deferred, /with context/);
	assert.match(deferred, /Be concise/);
	// Always: exactly one copy survives the rebuild (stale copy removed, then re-added).
	const alwaysEntry: ToolCatalogEntry = { ...alphaEntry, policy: "always" };
	const visible = stabilizeToolMetadata(text, options, [readEntry, alwaysEntry], true, options)!;
	assert.equal(visible.match(/Use alpha/g)?.length, 1);
});

test("changing role and safety text is preserved rather than freezing the system prompt", () => {
	const entries = [entry("read", "always")];
	const options = { cwd: "/tmp", toolSnippets: { read: "read snippet" } };
	const text = prompt(["read"], ["read guideline", "Do not delete files"], "New task: inspect only");
	const output = stabilizeToolMetadata(text, options, entries, true)!;
	assert.match(output, /Do not delete files/);
	assert.match(output, /New task: inspect only/);
	assert.ok(output.startsWith("Coding role"));
});

test("custom and ambiguous templates are left untouched", () => {
	assert.equal(hasStandardToolMetadata("Custom role"), false);
	assert.equal(hasStandardToolMetadata("Available tools:\nexample"), false);
	const text = prompt(["read"], []);
	assert.equal(stabilizeToolMetadata("Custom role", { cwd: "/tmp", customPrompt: "Custom role" }, [], true), undefined);
	assert.equal(stabilizeToolMetadata(`${text}\n\nAvailable tools:\nexample`, { cwd: "/tmp" }, [], true), undefined);
});

test("an overridden prompt that carries Pi's blocks is rewritten for its own tool set", () => {
	// Subagent sessions replace the system prompt but inherit a copy of Pi's
	// prompt: the inherited tool list must describe the child's own tools.
	const inherited = prompt(["read", "alpha", "ls", "tool_search"], ["alpha guideline", "Use ls for listings"]);
	const entries = [entry("read", "always"), entry("alpha", "deferred")];
	const options = {
		cwd: "/tmp",
		customPrompt: inherited,
		toolSnippets: { read: "read snippet", alpha: "alpha snippet" },
	};
	assert.equal(hasStandardToolMetadata(inherited), true);
	const output = stabilizeToolMetadata(inherited, options, entries, true, options)!;
	assert.match(output, /- read: read snippet/);
	assert.doesNotMatch(output, /- alpha:/);
	assert.doesNotMatch(output, /- ls:/);
	assert.doesNotMatch(output, /- tool_search:/);
	assert.doesNotMatch(output, /alpha guideline/);
	// Guidance that belongs to no known tool is preserved by design: the loader
	// never guesses which extension owns an unrecognized line.
	assert.match(output, /Use ls for listings/);
});

function result(name: string, addedToolNames: string[], details?: unknown): ContextEvent["messages"][number] {
	return { role: "toolResult", toolCallId: `${name}-1`, toolName: name, content: [], addedToolNames, details, isError: false, timestamp: 0 };
}

test("loader bookkeeping is repaired from durable intent without mutating transcript messages", () => {
	const history = new ActivationHistory();
	const original = result("tool_search", ["alpha", "beta"], { added: ["alpha"], active: ["alpha"] });
	const cleaned = history.sanitize([original]);
	assert.deepEqual((cleaned[0] as any).addedToolNames, ["alpha"]);
	assert.deepEqual((original as any).addedToolNames, ["alpha", "beta"]);
	assert.equal(history.sanitize([original])[0], cleaned[0]);
	const legacy = result("tool_search", ["legacy"]);
	assert.equal(history.sanitize([legacy])[0], legacy);
});

test("incidental activation corrections survive restore and preserve unrelated additions", () => {
	const history = new ActivationHistory();
	const message = result("alpha", ["beta", "foreign"]) as any;
	const saved = history.recordIncidental([message], new Set(["beta"]));
	assert.deepEqual((history.sanitize([message])[0] as any).addedToolNames, ["foreign"]);
	history.reset();
	history.restore(saved);
	assert.deepEqual((history.sanitize([message])[0] as any).addedToolNames, ["foreign"]);
});

test("request audit fingerprints stable prefix sections and historical inline positions", () => {
	const audit = new RequestAudit();
	const payload = { instructions: "Role", tools: [{ name: "read" }], input: [{ role: "user", content: "task" }] };
	assert.match(audit.observe(payload), /baseline/);
	const loaded = { ...payload, input: [...payload.input, { type: "additional_tools", role: "developer", tools: [{ name: "alpha" }] }] };
	assert.match(audit.observe(loaded), /stable/);
	assert.match(audit.observe({ ...loaded, input: [...loaded.input, { role: "user", content: "next" }] }), /stable/);
	assert.match(audit.observe({ ...loaded, tools: [{ name: "different" }] }), /top-level tools changed/);
	assert.match(audit.observe({ ...loaded, input: [...payload.input, ...loaded.input] }), /historical inline definitions changed/);
	assert.doesNotMatch(audit.status(), /"Role"|"task"/);
});

test("catalog tolerates unserializable tool schemas without breaking refresh", () => {
	const catalog = new ToolCatalog();
	const value = tool("odd");
	(value.parameters as Record<string, unknown>).self = value.parameters;
	assert.equal(catalog.refresh([value], new Set(["odd"]), new Map()), true);
	assert.equal(catalog.refresh([value], new Set(["odd"]), new Map()), false);
	// Only the unserializable field is demoted: reassigning it is still detected.
	const replacement = tool("odd");
	(replacement.parameters as Record<string, unknown>).self = replacement.parameters;
	assert.equal(catalog.refresh([replacement], new Set(["odd"]), new Map()), true);
	assert.equal(catalog.refresh([replacement], new Set(["odd"]), new Map()), false);
	// And the other fields keep full change detection for the same tool.
	replacement.promptGuidelines = ["odd guideline v2"];
	assert.equal(catalog.refresh([replacement], new Set(["odd"]), new Map()), true);
});

test("catalog ordering is code-point deterministic, never locale-dependent", () => {
	const catalog = new ToolCatalog();
	const names = ["toolsearch", "tool_searchx", "Tool_Searchx"];
	catalog.refresh(names.map((name) => tool(name)), new Set(names), new Map());
	assert.deepEqual(
		catalog.all().map((entry) => entry.tool.name),
		["Tool_Searchx", "tool_searchx", "toolsearch"],
	);
});

test("duplicate tool names resolve to a single last-in-order winner", () => {
	const catalog = new ToolCatalog();
	const first = tool("dup", "cli", "/tmp/dup-a.ts");
	const second = tool("dup", "cli", "/tmp/dup-b.ts");
	catalog.refresh([first, second], new Set(["dup"]), new Map());
	assert.equal(catalog.byName("dup")?.key, toolKey(second));
});

test("ownership comparison normalizes file URLs, home paths and relatives", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-search-owned-"));
	try {
		const entry = join(cwd, "src", "index.ts");
		const owned = tool("tool_search", "cli", "./src/index.ts");
		assert.equal(isOwnedBy(owned, entry, cwd), true);
		const fileUrl = tool("tool_search", "cli", pathToFileURL(entry).href);
		assert.equal(isOwnedBy(fileUrl, entry, cwd), true);
		const home = tool("tool_search", "cli", join(homedir(), "ext", "index.ts"));
		assert.equal(isOwnedBy(home, join(homedir(), "ext", "index.ts"), cwd), true);
		assert.equal(normalizeExtensionPath("~/ext/index.ts", cwd), join(homedir(), "ext", "index.ts"));
		const builtin = tool("read", "builtin", "<builtin:read>");
		assert.equal(isOwnedBy(builtin, entry, cwd), false);
		assert.equal(isOwnedBy(builtin, "<builtin:read>", cwd), true);
		assert.equal(isOwnedBy(owned, join(cwd, "other", "index.ts"), cwd), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("policy records carrying NUL bytes are ignored on load", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-search-nul-"));
	try {
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "pi-tool-search.json"),
			JSON.stringify({ version: 1, tools: [{ name: "a\u0000b", source: "x", policy: "always" }] }),
		);
		const loaded = await loadToolSearchPolicies(cwd);
		assert.equal(loaded.policies.size, 0);
		assert.match(loaded.diagnostic ?? "", /reserved separator/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("tool snippets ignore inherited object properties", () => {
	const catalog = new ToolCatalog();
	const ctor = tool("constructor");
	catalog.refresh([ctor], new Set(["constructor"]), new Map());
	const text = prompt(["constructor"], []);
	const rewritten = stabilizeToolMetadata(text, { cwd: "/tmp", toolSnippets: {} }, catalog.all(), false);
	assert.ok(rewritten && !rewritten.includes("- constructor:"));
});

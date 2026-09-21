import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadEffectiveToolSearchPolicies, loadToolSearchPolicies, saveToolSearchPolicies } from "../src/config.ts";
import { PROTECTED_TOOL_NAMES, ToolCatalog, isOwnedBy, normalizeExtensionPath, policyRecordKey, toolKey } from "../src/registry.ts";

function tool(name: string, source = "npm:test", path = "/tmp/providers/test/index.ts"): ToolInfo {
	return { name, description: `${name} description`, parameters: Type.Object({}), promptGuidelines: [`${name} guideline`], sourceInfo: { source, path, scope: "user", origin: "package" } };
}
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
	for (const source of ["cli", "auto"]) {
		assert.equal(toolKey(tool("grep", "npm:@ff-labs/pi-fff", path)), toolKey(tool("grep", source, path)));
	}
	assert.notEqual(toolKey(tool("search", "cli", "/tmp/a.ts")), toolKey(tool("search", "cli", "/tmp/b.ts")));
});

test("auto-discovered local providers have path-scoped identities and policies", () => {
	const first = tool("alpha", "auto", "/tmp/project-a/.pi/extensions/search/index.ts");
	const second = tool("alpha", "auto", "/tmp/project-b/.pi/extensions/search/index.ts");
	const key = toolKey(first);
	assert.equal(key, `file:${first.sourceInfo.path}\u0000alpha`);
	assert.equal(key, toolKey(tool("alpha", "cli", first.sourceInfo.path)));
	assert.notEqual(toolKey(second), key);
	const catalog = new ToolCatalog();
	for (const policy of ["always", "excluded"] as const) {
		const saved = new Map([[key, policy]]);
		catalog.refresh([first], new Set(["alpha"]), saved);
		assert.equal(catalog.byName("alpha")?.policy, policy);
		catalog.refresh([second], new Set(["alpha"]), saved);
		assert.equal(catalog.byName("alpha")?.policy, "deferred");
		assert.equal(catalog.byKey(key), undefined);
	}
	assert.deepEqual(catalog.policyRecords(new Map([[toolKey(second), "always"]])), [
		{ name: "alpha", source: `file:${second.sourceInfo.path}`, policy: "always" },
	]);
});

test("legacy auto policies retain only exclusions until a path-scoped override is saved", () => {
	const first = tool("alpha", "auto", "/tmp/auto-a/index.ts");
	const second = tool("alpha", "auto", "/tmp/auto-b/index.ts");
	const legacyKey = policyRecordKey({ name: "alpha", source: "auto" });
	const catalog = new ToolCatalog();
	for (const policy of ["always", "deferred", "excluded"] as const) {
		for (const provider of [first, second]) {
			catalog.refresh([provider], new Set(["alpha"]), new Map([[legacyKey, policy]]));
			assert.equal(catalog.byName("alpha")?.policy, policy === "excluded" ? "excluded" : "deferred");
		}
	}
	const legacy = new Map([[legacyKey, "excluded" as const]]);
	const scoped = new Map([[toolKey(first), "always" as const]]);
	catalog.refresh([first], new Set(["alpha"]), new Map([...legacy, ...scoped]));
	assert.equal(catalog.byName("alpha")?.policy, "always");
	catalog.refresh([first], new Set(["alpha"]), legacy, scoped);
	assert.equal(catalog.byName("alpha")?.policy, "always");
	catalog.refresh([first], new Set(["alpha"]), scoped, legacy);
	assert.equal(catalog.byName("alpha")?.policy, "excluded");
	// Auto-discovered npm providers already had package-scoped identities.
	catalog.refresh([tool("alpha", "auto", "/tmp/node_modules/fixture/index.ts")], new Set(["alpha"]), legacy);
	assert.equal(catalog.byName("alpha")?.policy, "deferred");
});

test("inline identities and saved policies are scoped to the factory path, not the shared source tag", () => {
	const first = tool("alpha", "inline", "<inline:provider-A>");
	const second = tool("alpha", "inline", "<inline:provider-B>");
	const key = toolKey(first, "/first-cwd");
	assert.equal(key, "inline:<inline:provider-A>\u0000alpha");
	assert.equal(toolKey(first, "/another-cwd"), key);
	assert.notEqual(toolKey(second), key);
	const catalog = new ToolCatalog();
	const active = new Set(["alpha"]);
	const saved = new Map([[key, "excluded" as const]]);
	catalog.refresh([first], active, saved);
	assert.equal(catalog.byName("alpha")?.policy, "excluded");
	catalog.refresh([second], active, saved);
	assert.equal(catalog.byName("alpha")?.policy, "deferred");
	assert.deepEqual(catalog.policyRecords(new Map([[toolKey(second), "always"]])), [
		{ name: "alpha", source: "inline:<inline:provider-B>", policy: "always" },
	]);
	// An old generic inline policy has no reliable factory provenance.
	catalog.refresh([first], active, new Map([["inline\u0000alpha", "always"]]));
	assert.equal(catalog.byName("alpha")?.policy, "deferred");
});

test("legacy inline exclusions stay closed until an explicit factory-scoped policy overrides them", () => {
	const first = tool("alpha", "inline", "<inline:provider-A>");
	const second = tool("alpha", "inline", "<inline:provider-B>");
	const active = new Set(["alpha"]);
	const catalog = new ToolCatalog();
	const legacy = new Map([["inline\u0000alpha", "excluded" as const]]);
	for (const provider of [first, second]) {
		catalog.refresh([provider], active, legacy);
		assert.equal(catalog.byName("alpha")?.policy, "excluded");
	}
	const scoped = new Map([[toolKey(first), "deferred" as const]]);
	catalog.refresh([first], active, new Map([...legacy, ...scoped]));
	assert.equal(catalog.byName("alpha")?.policy, "deferred");
	catalog.refresh([second], active, new Map([...legacy, ...scoped]));
	assert.equal(catalog.byName("alpha")?.policy, "excluded");
	catalog.refresh([first], active, legacy, scoped);
	assert.equal(catalog.byName("alpha")?.policy, "deferred", "project-scoped intent overrides global legacy exclusion");
	catalog.refresh([first], active, scoped, legacy);
	assert.equal(catalog.byName("alpha")?.policy, "excluded", "project legacy exclusion still outranks global policies");
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
		assert.equal(trusted.globalPolicies?.get("npm:fixture\u0000alpha"), "always");
		assert.equal(trusted.projectPolicies?.get("npm:fixture\u0000alpha"), "deferred");
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

test("symlinked provider paths share ownership and policy identity with their real paths", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-search-symlink-owner-"));
	try {
		const provider = join(cwd, "provider");
		await mkdir(provider);
		await writeFile(join(provider, "index.ts"), "");
		await symlink(provider, join(cwd, "linked"), "dir");
		const linked = tool("tool_search", "cli", "./linked/index.ts");
		const real = tool("tool_search", "cli", join(provider, "index.ts"));
		assert.equal(isOwnedBy(linked, real.sourceInfo.path, cwd), true);
		assert.equal(toolKey(linked, cwd), toolKey(real));
		assert.equal(toolKey(tool("tool_search", "auto", "./linked/index.ts"), cwd), toolKey(real));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("relative provider identity, catalog lookup and saved records use the session cwd", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-search-relative-identity-"));
	try {
		const relative = tool("alpha", "cli", "./provider.ts");
		const absolute = tool("alpha", "cli", join(cwd, "provider.ts"));
		const key = toolKey(absolute);
		assert.equal(toolKey(relative, cwd), key);
		assert.equal(toolKey(tool("alpha", "cli", pathToFileURL(absolute.sourceInfo.path).href), cwd), key);
		assert.notEqual(toolKey(relative, join(cwd, "other")), key);
		const catalog = new ToolCatalog(cwd);
		catalog.refresh([relative], new Set(), new Map([[key, "always"]]));
		assert.equal(catalog.byName("alpha")?.key, key);
		assert.equal(catalog.byKey(key)?.policy, "always");
		assert.deepEqual(catalog.policyRecords(new Map([[key, "excluded"]])), [{
			name: "alpha", source: `file:${absolute.sourceInfo.path}`, policy: "excluded",
		}]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("removing a file policy restores the original default rather than the old effective value", () => {
	const value = tool("alpha");
	const catalog = new ToolCatalog();
	catalog.refresh([value], new Set(), new Map([[toolKey(value), "always"]]));
	assert.equal(catalog.byName("alpha")?.policy, "always");
	catalog.refresh([value], new Set(["alpha"]), new Map());
	assert.equal(catalog.byName("alpha")?.policy, "excluded");
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

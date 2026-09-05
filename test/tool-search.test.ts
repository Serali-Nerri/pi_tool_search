import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CONFIG_DIR_NAME, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	legacyToolSearchConfigPath,
	loadToolSearchPolicies,
	saveToolSearchPolicies,
	toolSearchConfigPath,
	TOOL_SEARCH_CONFIG_MAX_BYTES,
} from "../src/config.ts";
import {
	buildToolManifest,
	shortToolDescription,
	TOOL_DESCRIPTION_MAX_BYTES,
} from "../src/manifest.ts";
import {
	ToolCatalog,
	policyRecordKey,
	type ToolCatalogEntry,
} from "../src/registry.ts";
import {
	loadTrustedToolSearchPolicies,
	saveToolSearchConfiguration,
} from "../src/index.ts";
import { suggestToolNames } from "../src/tool.ts";
import { toolSearchEntryLabel } from "../src/ui.ts";

function tool(name: string, source: string, description = `${name} description`): ToolInfo {
	return {
		name,
		description,
		parameters: Type.Object({ value: Type.Optional(Type.String()) }),
		promptGuidelines: undefined,
		sourceInfo: {
			path: `/packages/${source}/index.ts`,
			source,
			scope: "user",
			origin: "package",
		},
	};
}

test("short descriptions sanitize markdown and stay within the UTF-8 budget", () => {
	const description = `**解析_document**。${"很长的中文说明".repeat(50)}\n\u0000 trailing`;
	const short = shortToolDescription(description);
	assert.ok(Buffer.byteLength(short, "utf8") <= TOOL_DESCRIPTION_MAX_BYTES);
	assert.doesNotMatch(short, /[*\u0000\n]/);
	assert.match(short, /^解析_document。/);
});

test("the deferred manifest is bounded and contains only names plus short descriptions", () => {
	const entries: ToolCatalogEntry[] = Array.from({ length: 20 }, (_, index) => ({
		key: `source\u0000tool_${index}`,
		tool: tool(`tool_${index}`, "source", `Capability ${index}. ${"extra ".repeat(80)}`),
		policy: "deferred",
		protected: false,
	}));
	const manifest = buildToolManifest(entries, 360);
	assert.ok(Buffer.byteLength(manifest.text, "utf8") <= 360);
	assert.ok(manifest.omitted > 0);
	assert.match(manifest.text, /tool_0 — Capability 0\./);
	assert.doesNotMatch(manifest.text, /parameters|properties|JSON Schema/i);
});

test("catalog defaults every active non-base tool to deferred and inactive tools to excluded", () => {
	const catalog = new ToolCatalog();
	const tools = [
		tool("read", "builtin"),
		tool("bash", "builtin"),
		tool("web_search", "pi-web-access"),
		tool("document_parse", "pi-docparser"),
		tool("grep", "builtin"),
		tool("goal_complete", "pi-goal"),
	];
	catalog.refresh(tools, new Set(["read", "bash", "web_search", "goal_complete"]), new Map());
	assert.equal(catalog.byName("read")?.policy, "always");
	assert.equal(catalog.byName("goal_complete")?.policy, "deferred");
	assert.equal(catalog.byName("web_search")?.policy, "deferred");
	assert.equal(catalog.byName("document_parse")?.policy, "excluded");
	assert.equal(catalog.byName("grep")?.policy, "always");
});

test("saved policies are keyed by source and cannot override protected tools", () => {
	const catalog = new ToolCatalog();
	const read = tool("read", "builtin");
	const web = tool("web_search", "pi-web-access");
	const policies = new Map([
		[policyRecordKey({ name: "read", source: "builtin" }), "excluded" as const],
		[policyRecordKey({ name: "web_search", source: "pi-web-access" }), "always" as const],
	]);
	catalog.refresh([read, web], new Set(["read", "web_search"]), policies);
	assert.equal(catalog.byName("read")?.policy, "always");
	assert.equal(catalog.byName("web_search")?.policy, "always");
});

test("project policy files round-trip without touching Pi settings", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-search-config-"));
	try {
		const records = [
			{ name: "web_search", source: "npm:pi-web-access", policy: "deferred" as const },
			{ name: "document_parse", source: "npm:pi-docparser", policy: "always" as const },
		];
		const path = await saveToolSearchPolicies(cwd, records);
		assert.equal(path, join(cwd, CONFIG_DIR_NAME, "pi-tool-search.json"));
		assert.equal(path, toolSearchConfigPath(cwd));
		const loaded = await loadToolSearchPolicies(cwd);
		assert.equal(loaded.policies.get(policyRecordKey(records[0])), "deferred");
		assert.equal(loaded.policies.get(policyRecordKey(records[1])), "always");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("legacy claude-style-tools policies remain readable after the split", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-search-legacy-config-"));
	try {
		const record = { name: "web_search", source: "npm:pi-web-access", policy: "always" as const };
		const path = legacyToolSearchConfigPath(cwd);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify({ version: 1, tools: [record] }));
		const loaded = await loadToolSearchPolicies(cwd);
		assert.equal(loaded.policies.get(policyRecordKey(record)), "always");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("invalid and oversized policy files produce diagnostics instead of silent empty policies", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-search-invalid-config-"));
	try {
		const path = toolSearchConfigPath(cwd);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "{ bad json");
		assert.match((await loadToolSearchPolicies(cwd)).diagnostic ?? "", /malformed/);
		await writeFile(path, JSON.stringify({ version: 999, tools: [] }));
		assert.match((await loadToolSearchPolicies(cwd)).diagnostic ?? "", /unsupported/);
		await writeFile(path, "x".repeat(TOOL_SEARCH_CONFIG_MAX_BYTES + 1));
		assert.match((await loadToolSearchPolicies(cwd)).diagnostic ?? "", /too large/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("untrusted projects cannot load project-local tool policies", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-search-trust-config-"));
	try {
		const records = [{ name: "web_search", source: "npm:pi-web-access", policy: "always" as const }];
		await saveToolSearchPolicies(cwd, records);
		const untrusted = await loadTrustedToolSearchPolicies(cwd, { isProjectTrusted: () => false });
		assert.equal(untrusted.policies.size, 0);
		const trusted = await loadTrustedToolSearchPolicies(cwd, { isProjectTrusted: () => true });
		assert.equal(trusted.policies.get(policyRecordKey(records[0])), "always");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("policy saves cannot create a file that the bounded loader will reject", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-search-large-save-"));
	try {
		const records = Array.from({ length: 2_000 }, (_, index) => ({
			name: `tool_${index}_${"x".repeat(80)}`,
			source: "test",
			policy: "deferred" as const,
		}));
		await assert.rejects(saveToolSearchPolicies(cwd, records), /exceeds/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("tool configuration labels use the actual winning source", () => {
	const local: ToolCatalogEntry = {
		key: "local\u0000read",
		tool: tool("read", "local"),
		policy: "always" as const,
		protected: true,
	};
	assert.equal(toolSearchEntryLabel(local, local.tool.sourceInfo.path), "pi-tool-search · read 🔒");
	const external = { ...local, key: "external\u0000read", tool: tool("read", "npm:override") };
	assert.equal(toolSearchEntryLabel(external, "/extension/pi-tool-search/index.ts"), "npm:override · read 🔒");
});

test("a failed policy save leaves the in-memory catalog unchanged", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-search-save-failure-"));
	try {
		await writeFile(join(cwd, CONFIG_DIR_NAME), "not a directory");
		const catalog = new ToolCatalog();
		const web = tool("web_search", "pi-web-access");
		catalog.refresh([web], new Set([web.name]), new Map());
		const entry = catalog.byName(web.name);
		assert.ok(entry);
		await assert.rejects(saveToolSearchConfiguration(cwd, catalog, new Map([[entry.key, "always"]])));
		assert.equal(catalog.byName(web.name)?.policy, "deferred");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("unknown exact names receive bounded typo suggestions without activation", () => {
	assert.deepEqual(suggestToolNames("web_seach", ["web_search", "fetch_content", "document_search"]), [
		"web_search",
	]);
	assert.deepEqual(suggestToolNames("totally_unknown", ["web_search"]), []);
});

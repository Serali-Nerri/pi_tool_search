import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	globalToolSearchConfigPath,
	saveGlobalToolSearchPolicies,
	saveToolSearchPolicies,
	toolSearchConfigPath,
	TOOL_SEARCH_CONFIG_MAX_BYTES,
} from "../src/config.ts";
import type { ToolPolicyRecord } from "../src/registry.ts";

const alpha: ToolPolicyRecord = { name: "alpha", source: "npm:fixture", policy: "always" };
const absent: ToolPolicyRecord = { name: "absent", source: "npm:other", policy: "excluded" };

// Every global writer in this file receives an explicit, disposable agent directory.
for (const scope of ["global", "project"] as const) {
	test(`${scope} saves merge edits without dropping absent providers or unrelated metadata`, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-policy-merge-"));
		try {
			const path = scope === "global" ? globalToolSearchConfigPath(root) : toolSearchConfigPath(root);
			const save = (edits: ToolPolicyRecord[]) => scope === "global"
				? saveGlobalToolSearchPolicies(edits, root)
				: saveToolSearchPolicies(root, edits);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, JSON.stringify({
				version: 1, mode: "eager", audit: true, note: "keep this",
				tools: [absent, { ...alpha, policy: "deferred", note: "keep record metadata" }],
			}));
			const saved = await save([alpha]);
			assert.equal(saved.path, path);
			assert.equal(saved.skipped, 0);
			const written = JSON.parse(await readFile(path, "utf8"));
			assert.deepEqual(written, {
				version: 1, mode: "eager", audit: true, note: "keep this",
				tools: [absent, { ...alpha, note: "keep record metadata" }],
			});
			assert.deepEqual(saved.records, written.tools);
			const before = await readFile(path, "utf8");
			await save([]);
			assert.equal(await readFile(path, "utf8"), before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test(`${scope} saves refuse invalid existing files without changing their bytes`, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-policy-invalid-save-"));
		try {
			const path = scope === "global" ? globalToolSearchConfigPath(root) : toolSearchConfigPath(root);
			const save = () => scope === "global"
				? saveGlobalToolSearchPolicies([alpha], root)
				: saveToolSearchPolicies(root, [alpha]);
			await mkdir(dirname(path), { recursive: true });
			for (const text of [
				"{ invalid JSON",
				JSON.stringify({ version: 2, mode: "eager", audit: true, tools: [absent] }),
				JSON.stringify({ version: 1, mode: "bad", tools: [absent] }),
				JSON.stringify({ version: 1, tools: [{ ...absent, policy: "bad" }] }),
				JSON.stringify({ version: 1, tools: [{ ...absent, name: "bad\u0000name" }] }),
				"x".repeat(TOOL_SEARCH_CONFIG_MAX_BYTES + 1),
			]) {
				await writeFile(path, text);
				await assert.rejects(save(), /Refusing to overwrite/);
				assert.equal(await readFile(path, "utf8"), text);
				await assert.rejects(lstat(`${path}.lock`), { code: "ENOENT" });
			}
			// A failed save must release its lock so a corrected file can be saved.
			await writeFile(path, JSON.stringify({ version: 1, tools: [absent] }));
			await save();
			assert.equal(JSON.parse(await readFile(path, "utf8")).tools.length, 2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test(`${scope} saves reject symlinks, including dangling ones, without replacing them`, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-policy-symlink-save-"));
		try {
			const path = scope === "global" ? globalToolSearchConfigPath(root) : toolSearchConfigPath(root);
			const save = () => scope === "global"
				? saveGlobalToolSearchPolicies([alpha], root)
				: saveToolSearchPolicies(root, [alpha]);
			await mkdir(dirname(path), { recursive: true });
			const target = join(root, "dotfiles.json");
			const original = JSON.stringify({ version: 1, mode: "eager", tools: [absent] });
			await writeFile(target, original);
			await symlink(target, path);
			await assert.rejects(save(), /symbolic-link/);
			assert.equal((await lstat(path)).isSymbolicLink(), true);
			assert.equal(await readFile(target, "utf8"), original);
			await rm(target);
			await assert.rejects(save(), /symbolic-link/);
			assert.equal((await lstat(path)).isSymbolicLink(), true);
			await assert.rejects(lstat(target), { code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("parallel policy edits are serialized and merged", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-policy-parallel-"));
	try {
		await Promise.all([
			saveGlobalToolSearchPolicies([alpha], agentDir),
			saveGlobalToolSearchPolicies([absent], agentDir),
		]);
		const written = JSON.parse(await readFile(globalToolSearchConfigPath(agentDir), "utf8"));
		assert.deepEqual(new Set(written.tools.map((record: ToolPolicyRecord) => record.name)), new Set(["alpha", "absent"]));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("an existing cross-process save lock fails safely without deleting the other writer's lock", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-policy-lock-"));
	try {
		const path = globalToolSearchConfigPath(agentDir);
		const original = JSON.stringify({ version: 1, tools: [absent] });
		await writeFile(path, original);
		await writeFile(`${path}.lock`, "other writer");
		await assert.rejects(saveGlobalToolSearchPolicies([alpha], agentDir), /locked by another save/);
		assert.equal(await readFile(path, "utf8"), original);
		assert.equal(await readFile(`${path}.lock`, "utf8"), "other writer");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("the size limit is enforced on the merged file, not just incoming edits", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-policy-merged-limit-"));
	try {
		await saveGlobalToolSearchPolicies([{ ...absent, name: "a".repeat(40_000) }], agentDir);
		const path = globalToolSearchConfigPath(agentDir);
		const original = await readFile(path, "utf8");
		await assert.rejects(saveGlobalToolSearchPolicies([{ ...alpha, name: "b".repeat(40_000) }], agentDir), /exceeds/);
		assert.equal(await readFile(path, "utf8"), original);
		await assert.rejects(lstat(`${path}.lock`), { code: "ENOENT" });
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

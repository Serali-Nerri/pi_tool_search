import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { configureSubagents } = await import(new URL("../scripts/configure-subagents.mjs", import.meta.url).href);
const { deploy } = await import(new URL("../scripts/deploy.mjs", import.meta.url).href);

test("configuration merge preserves model/thinking, other roles/packages and FFF options; reruns are idempotent", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-configuration-"));
	try {
		const settings = { packages: ["npm:pi-subagents", "npm:other"], customSetting: 42, subagents: { timeout: 5, agentOverrides: {
			worker: { model: "custom/model", thinking: "max", extra: true }, custom: { model: "other/model" },
		} } };
		const text = JSON.stringify(settings);
		await writeFile(join(root, "settings.json"), text);
		await writeFile(join(root, "pi-fff.json"), JSON.stringify({ mode: "tools-only", custom: true }));
		const preview = await configureSubagents(root, { dryRun: true });
		assert.equal(preview.changed.length, 3);
		assert.equal(await readFile(join(root, "settings.json"), "utf8"), text);
		const report = await configureSubagents(root);
		assert.equal(await readFile(join(report.backup, "settings.json"), "utf8"), text);
		const saved = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
		assert.deepEqual(saved.packages, settings.packages);
		assert.equal(saved.customSetting, 42);
		assert.equal(saved.subagents.timeout, 5);
		assert.deepEqual(saved.subagents.defaultExtensions, []);
		assert.equal(saved.subagents.agentOverrides.worker.model, "custom/model");
		assert.equal(saved.subagents.agentOverrides.worker.thinking, "max");
		assert.equal(saved.subagents.agentOverrides.worker.extra, true);
		assert.deepEqual(saved.subagents.agentOverrides.custom, settings.subagents.agentOverrides.custom);
		assert.ok(saved.subagents.agentOverrides.worker.extensions.every((path: string) => path.startsWith(root)));
		for (const role of ["scout", "delegate", "oracle", "worker", "reviewer", "researcher"]) {
			const agent = saved.subagents.agentOverrides[role];
			assert.equal(agent.extensions.includes(join(root, "extensions/rtk.ts")), agent.tools.includes("bash"));
			assert.equal(agent.extensions.at(-1), join(root, "extensions/pi-tool-search/index.ts"));
			const documentsEnabled = ["delegate", "reviewer", "researcher"].includes(role);
			assert.equal(agent.extensions.includes(join(root, "npm/node_modules/pi-docparser/extensions/docparser/index.ts")), documentsEnabled);
			for (const name of ["document_parse", "document_search", "document_screenshot"]) assert.equal(agent.tools.includes(name), documentsEnabled);
			assert.ok(agent.extensions.every((path: string) => !/pi-freeflow|doompi-autocompact/.test(path)));
		}
		const policies = JSON.parse(await readFile(join(root, "pi-tool-search.json"), "utf8"));
		assert.deepEqual(policies.tools.filter((value: any) => value.source === "npm:pi-docparser").map((value: any) => [value.name, value.policy]), [
			["document_parse", "deferred"], ["document_search", "deferred"], ["document_screenshot", "deferred"],
		]);
		assert.ok(["bash", "edit", "write"].every((name) => !saved.subagents.agentOverrides.reviewer.tools.includes(name)));
		assert.deepEqual(JSON.parse(await readFile(join(root, "pi-fff.json"), "utf8")), { mode: "override", custom: true });
		assert.deepEqual((await configureSubagents(root)).changed, []);
		assert.equal((await readdir(join(root, "config-backups"))).length, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid or symlinked configuration aborts before any settings write", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-config-invalid-"));
	try {
		await writeFile(join(root, "settings.json"), "{}");
		await writeFile(join(root, "pi-fff.json"), "broken JSON");
		await assert.rejects(configureSubagents(root));
		assert.equal(await readFile(join(root, "settings.json"), "utf8"), "{}");
		await rm(join(root, "pi-fff.json"));
		await symlink(join(root, "settings.json"), join(root, "pi-fff.json"));
		await assert.rejects(configureSubagents(root), /non-regular/);
		assert.equal(await readFile(join(root, "settings.json"), "utf8"), "{}");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("deployment retains each prior version in a unique backup", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-deploy-"));
	try {
		const source = join(root, "source");
		const agent = join(root, "agent");
		await mkdir(source);
		await writeFile(join(source, "index.ts"), "first");
		const first = await deploy(agent, source);
		assert.equal(first.backup, undefined);
		await writeFile(join(source, "index.ts"), "second");
		const second = await deploy(agent, source);
		await writeFile(join(source, "index.ts"), "third");
		const third = await deploy(agent, source);
		assert.notEqual(second.backup, third.backup);
		assert.equal(await readFile(join(second.backup, "index.ts"), "utf8"), "first");
		assert.equal(await readFile(join(third.backup, "index.ts"), "utf8"), "second");
		assert.equal(await readFile(join(third.target, "index.ts"), "utf8"), "third");
		assert.deepEqual(await readdir(join(agent, "extensions")), ["pi-tool-search"]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("failed staging leaves the installed extension intact", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-deploy-failure-"));
	try {
		const target = join(root, "extensions/pi-tool-search");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "index.ts"), "original");
		await assert.rejects(deploy(root, join(root, "missing-source")));
		assert.equal(await readFile(join(target, "index.ts"), "utf8"), "original");
		assert.deepEqual(await readdir(join(root, "extensions")), ["pi-tool-search"]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

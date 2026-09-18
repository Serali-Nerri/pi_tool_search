import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { deploy } = await import(new URL("../scripts/deploy.mjs", import.meta.url).href);

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

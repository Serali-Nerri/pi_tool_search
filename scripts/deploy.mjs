import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function deploy(agentDir, source = join(projectRoot, "src")) {
	const extensionsDir = join(resolve(agentDir), "extensions");
	const target = join(extensionsDir, "pi-tool-search");
	const backup = join(resolve(agentDir), "extension-backups", `pi-tool-search-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
	await mkdir(extensionsDir, { recursive: true });
	try {
		const stat = await lstat(target);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing non-directory deployment target: ${target}`);
	} catch (error) { if (error.code !== "ENOENT") throw error; }
	const stage = await mkdtemp(join(extensionsDir, ".pi-tool-search-stage-"));
	let movedPrevious = false;
	try {
		await cp(source, stage, { recursive: true });
		await mkdir(dirname(backup), { recursive: true });
		try {
			await rename(target, backup);
			movedPrevious = true;
		} catch (error) { if (error.code !== "ENOENT") throw error; }
		try { await rename(stage, target); }
		catch (error) {
			if (movedPrevious) await rename(backup, target);
			throw error;
		}
	} finally { await rm(stage, { recursive: true, force: true }); }
	return { source, target, backup: movedPrevious ? backup : undefined };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length && (args.length !== 2 || args[0] !== "--agent-dir")) throw new Error("Usage: node scripts/deploy.mjs [--agent-dir PATH]");
	console.log(JSON.stringify(await deploy(args[1] ?? join(homedir(), ".pi", "agent")), null, 2));
}

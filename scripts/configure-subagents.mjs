import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleAgentDir = "/home/thelya/.pi/agent";
const webTools = ["web_search", "fetch_content", "get_search_content"];
const documentTools = ["document_parse", "document_search", "document_screenshot"];
const deferredDefaults = [
	...webTools.map((name) => ({ name, source: "npm:pi-web-access", policy: "deferred" })),
	...documentTools.map((name) => ({ name, source: "npm:pi-docparser", policy: "deferred" })),
];

function object(value, label) {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
	return value;
}

async function currentFile(path) {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular config target: ${path}`);
		return await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

/** Merge only documented compatibility fields; preserve model/thinking and unrelated settings. */
export async function configureSubagents(agentDir, { dryRun = false } = {}) {
	agentDir = resolve(agentDir);
	const names = ["settings.json", "pi-fff.json", "pi-tool-search.json"];
	const paths = names.map((name) => join(agentDir, name));
	const originals = await Promise.all(paths.map(currentFile));
	const [settings, fff, toolSearch] = originals.map((text, i) => object(text === undefined ? {} : JSON.parse(text), names[i]));
	const subagents = object(settings.subagents, "subagents");
	const overrides = object(subagents.agentOverrides, "subagents.agentOverrides");
	const example = JSON.parse(await readFile(join(projectRoot, "docs/subagents-settings.example.json"), "utf8"));
	const merged = { ...overrides };
	for (const [name, fields] of Object.entries(example.subagents.agentOverrides)) {
		merged[name] = {
			...object(overrides[name], `agentOverrides.${name}`), ...fields,
			extensions: fields.extensions.map((path) => path.replace(`${exampleAgentDir}/`, `${agentDir}/`)),
		};
	}
	if (toolSearch.version !== undefined && toolSearch.version !== 1) throw new Error("Unsupported existing tool-search config version");
	if (toolSearch.tools !== undefined && !Array.isArray(toolSearch.tools)) throw new Error("tool-search tools must be an array");
	const policies = (toolSearch.tools ?? []).filter((entry) => !deferredDefaults.some((preset) => entry?.source === preset.source && entry.name === preset.name));
	const values = [
		{ ...settings, subagents: { ...subagents, defaultExtensions: [...example.subagents.defaultExtensions], agentOverrides: merged } },
		{ ...fff, mode: "override" },
		{ ...toolSearch, version: 1, mode: "auto", audit: false, tools: [...policies, ...deferredDefaults] },
	];
	const changes = values.map((value, i) => ({ path: paths[i], name: names[i], old: originals[i], text: `${JSON.stringify(value, null, 2)}\n` }))
		.filter((entry) => entry.old !== entry.text);
	if (Buffer.byteLength(JSON.stringify(values[2])) > 64 * 1024) throw new Error("Tool-search config exceeds its 64 KiB limit");
	if (dryRun || changes.length === 0) return { dryRun, changed: changes.map((entry) => entry.path), roles: Object.keys(example.subagents.agentOverrides) };
	const backup = join(agentDir, "config-backups", `tool-search-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
	await mkdir(backup, { recursive: true, mode: 0o700 });
	const committed = [];
	try {
		for (const change of changes) {
			if (change.old !== undefined) await writeFile(join(backup, change.name), change.old, { flag: "wx", mode: 0o600 });
		}
		for (const change of changes) {
			if (await currentFile(change.path) !== change.old) throw new Error(`Configuration changed concurrently: ${change.path}`);
			const temporary = `${change.path}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, change.text, { flag: "wx", mode: 0o600 });
				await rename(temporary, change.path);
				committed.push(change);
			} finally { await rm(temporary, { force: true }); }
		}
	} catch (error) {
		for (const change of committed.reverse()) {
			if (await currentFile(change.path) !== change.text) continue;
			if (change.old === undefined) await rm(change.path);
			else {
				const temporary = `${change.path}.${randomUUID()}.rollback`;
				await writeFile(temporary, change.old, { flag: "wx", mode: 0o600 });
				await rename(temporary, change.path);
			}
		}
		throw error;
	}
	return { changed: changes.map((entry) => entry.path), backup, roles: Object.keys(example.subagents.agentOverrides) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	let agentDir = join(homedir(), ".pi", "agent");
	let dryRun = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--dry-run") dryRun = true;
		else if (args[i] === "--agent-dir" && args[i + 1]) agentDir = args[++i];
		else throw new Error("Usage: node scripts/configure-subagents.mjs [--agent-dir PATH] [--dry-run]");
	}
	console.log(JSON.stringify(await configureSubagents(agentDir, { dryRun }), null, 2));
}

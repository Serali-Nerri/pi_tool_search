import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	hasReservedToolKeyPart,
	policyRecordKey,
	type ToolPolicy,
	type ToolPolicyRecord,
} from "./registry.ts";

const CONFIG_VERSION = 1;
const CONFIG_FILE_NAME = "pi-tool-search.json";
export const TOOL_SEARCH_CONFIG_MAX_BYTES = 64 * 1024;
const VALID_POLICIES = new Set<ToolPolicy>(["always", "deferred", "excluded"]);

export interface ToolSearchProjectConfig {
	version: 1;
	tools: ToolPolicyRecord[];
	mode?: "auto" | "eager";
	audit?: boolean;
}

export interface LoadedToolSearchPolicies {
	policies: Map<string, ToolPolicy>;
	globalPolicies?: Map<string, ToolPolicy>;
	projectPolicies?: Map<string, ToolPolicy>;
	diagnostic?: string;
	mode?: "auto" | "eager";
	audit?: boolean;
}

export function toolSearchConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

export function globalToolSearchConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

interface LoadedPolicyFile extends LoadedToolSearchPolicies {
	config?: ToolSearchProjectConfig;
}

async function loadToolSearchPoliciesAt(path: string): Promise<LoadedPolicyFile | undefined> {
	try {
		const handle = await open(path, "r");
		try {
			const metadata = await handle.stat();
			if (!metadata.isFile()) {
				return { policies: new Map(), diagnostic: "Tool-search policy is not a regular file; ignoring it." };
			}
			if (metadata.size > TOOL_SEARCH_CONFIG_MAX_BYTES) {
				return {
					policies: new Map(),
					diagnostic: `Tool-search policy is too large (maximum ${TOOL_SEARCH_CONFIG_MAX_BYTES} bytes).`,
				};
			}
			const buffer = Buffer.alloc(TOOL_SEARCH_CONFIG_MAX_BYTES + 1);
			let bytesRead = 0;
			while (bytesRead < buffer.length) {
				const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
				if (result.bytesRead === 0) break;
				bytesRead += result.bytesRead;
			}
			if (bytesRead > TOOL_SEARCH_CONFIG_MAX_BYTES) {
				return {
					policies: new Map(),
					diagnostic: `Tool-search policy is too large (maximum ${TOOL_SEARCH_CONFIG_MAX_BYTES} bytes).`,
				};
			}
			const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as Partial<ToolSearchProjectConfig>;
			if (parsed?.version !== CONFIG_VERSION || !Array.isArray(parsed.tools)
				|| (parsed.mode !== undefined && !["auto", "eager"].includes(parsed.mode))
				|| (parsed.audit !== undefined && typeof parsed.audit !== "boolean")) {
				return {
					policies: new Map(),
					diagnostic: "Tool-search policy has an unsupported version or invalid format.",
				};
			}
			const policies = new Map<string, ToolPolicy>();
			let skipped = 0;
			let invalid = 0;
			for (const record of parsed.tools) {
				if (
					!record ||
					typeof record.name !== "string" ||
					typeof record.source !== "string" ||
					!VALID_POLICIES.has(record.policy)
				) {
					invalid++;
					continue;
				}
				if (hasReservedToolKeyPart(record)) {
					skipped++;
					continue;
				}
				policies.set(policyRecordKey(record), record.policy);
			}
			return {
				policies,
				config: parsed as ToolSearchProjectConfig,
				mode: parsed.mode,
				audit: parsed.audit,
				diagnostic: [
					skipped > 0 ? `${skipped} tool policy record(s) ignored: reserved separator in name/source.` : "",
					invalid > 0 ? `${invalid} invalid tool policy record(s) ignored.` : "",
				].filter(Boolean).join(" ") || undefined,
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		const reason = error instanceof SyntaxError ? "malformed JSON" : "unreadable";
		return { policies: new Map(), diagnostic: `Tool-search policy is ${reason}; ignoring it.` };
	}
}

/** Loads only a small, validated project policy file; callers must check trust first. */
export async function loadToolSearchPolicies(cwd: string): Promise<LoadedToolSearchPolicies> {
	return await loadToolSearchPoliciesAt(toolSearchConfigPath(cwd))
		?? { policies: new Map() };
}

export async function loadEffectiveToolSearchPolicies(
	cwd: string,
	trusted: boolean,
	agentDir = getAgentDir(),
): Promise<LoadedToolSearchPolicies> {
	const global = await loadToolSearchPoliciesAt(globalToolSearchConfigPath(agentDir));
	const project = trusted ? await loadToolSearchPolicies(cwd) : undefined;
	return {
		policies: new Map([...(global?.policies ?? []), ...(project?.policies ?? [])]),
		globalPolicies: global?.policies ?? new Map(),
		projectPolicies: project?.policies,
		mode: project?.mode ?? global?.mode ?? "auto",
		audit: project?.audit ?? global?.audit ?? false,
		diagnostic: [global?.diagnostic, project?.diagnostic].filter(Boolean).join(" ") || undefined,
	};
}

export interface SavedToolSearchPolicies {
	path: string;
	/** Complete target layer after merging the edits; incoming NUL-bearing records are skipped. */
	records: ToolPolicyRecord[];
	skipped: number;
}

async function assertRegularConfigTarget(path: string): Promise<void> {
	try {
		const metadata = await lstat(path);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error(`Refusing non-regular or symbolic-link tool-search policy: ${path}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** Merge only the submitted edits, retaining policies for absent providers and unrelated settings. */
async function saveToolSearchPoliciesAt(path: string, tools: ToolPolicyRecord[]): Promise<SavedToolSearchPolicies> {
	return withFileMutationQueue(path, async () => {
		await assertRegularConfigTarget(path);
		await mkdir(dirname(path), { recursive: true });
		// The Pi queue serializes writers in this process; an exclusive lock also
		// prevents two independent Pi processes from losing each other's edits.
		const lockPath = `${path}.lock`;
		let lock;
		try {
			lock = await open(lockPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error(`Tool-search policy is locked by another save: ${lockPath}. Retry when it finishes; remove a stale lock only when no writer is running.`);
			}
			throw error;
		}
		const tempPath = `${path}.${randomUUID()}.tmp`;
		try {
			await assertRegularConfigTarget(path);
			const previous = await loadToolSearchPoliciesAt(path);
			if (previous?.diagnostic) {
				throw new Error(`Refusing to overwrite tool-search policy: ${previous.diagnostic}`);
			}
			const edits = tools.filter((record) => !hasReservedToolKeyPart(record));
			const merged = new Map((previous?.config?.tools ?? []).map((record) => [policyRecordKey(record), record]));
			for (const record of edits) {
				if (!VALID_POLICIES.has(record.policy)) throw new Error("Invalid tool-search policy value.");
				const key = policyRecordKey(record);
				merged.set(key, { ...merged.get(key), ...record });
			}
			const records = [...merged.values()];
			const saved = { path, records, skipped: tools.length - edits.length };
			if (edits.length === 0) return saved;
			const config: ToolSearchProjectConfig = { ...previous?.config, version: CONFIG_VERSION, tools: records };
			const content = `${JSON.stringify(config, null, 2)}\n`;
			if (Buffer.byteLength(content, "utf8") > TOOL_SEARCH_CONFIG_MAX_BYTES) {
				throw new Error(`Tool-search policy exceeds ${TOOL_SEARCH_CONFIG_MAX_BYTES} bytes.`);
			}
			await writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await assertRegularConfigTarget(path);
			await rename(tempPath, path);
			return saved;
		} finally {
			await rm(tempPath, { force: true }).catch(() => undefined);
			await lock.close();
			await rm(lockPath, { force: true });
		}
	});
}

/** Merges project-scoped policy edits into <cwd>/.pi/pi-tool-search.json. */
export async function saveToolSearchPolicies(cwd: string, tools: ToolPolicyRecord[]): Promise<SavedToolSearchPolicies> {
	return saveToolSearchPoliciesAt(toolSearchConfigPath(cwd), tools);
}

/** Merges global policy edits into <agentDir>/pi-tool-search.json. */
export async function saveGlobalToolSearchPolicies(tools: ToolPolicyRecord[], agentDir = getAgentDir()): Promise<SavedToolSearchPolicies> {
	return saveToolSearchPoliciesAt(globalToolSearchConfigPath(agentDir), tools);
}

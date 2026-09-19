import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	policyRecordKey,
	type ToolPolicy,
	type ToolPolicyRecord,
} from "./registry.ts";

const CONFIG_VERSION = 1;
const CONFIG_FILE_NAME = "pi-tool-search.json";
const LEGACY_CONFIG_FILE_NAME = "claude-style-tools.json";
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
	projectPolicies?: Map<string, ToolPolicy>;
	diagnostic?: string;
	mode?: "auto" | "eager";
	audit?: boolean;
}

export function toolSearchConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

export function legacyToolSearchConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, LEGACY_CONFIG_FILE_NAME);
}

async function loadToolSearchPoliciesAt(path: string): Promise<LoadedToolSearchPolicies | undefined> {
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
			for (const record of parsed.tools) {
				if (
					!record ||
					typeof record.name !== "string" ||
					typeof record.source !== "string" ||
					!VALID_POLICIES.has(record.policy)
				) continue;
				// The NUL byte is our composite-key separator: a record carrying
				// it could alias another tool's policy, so skip the record.
				if (record.name.includes("\u0000") || record.source.includes("\u0000")) {
					skipped++;
					continue;
				}
				policies.set(policyRecordKey(record), record.policy);
			}
			return {
				policies,
				mode: parsed.mode,
				audit: parsed.audit,
				diagnostic: skipped > 0
					? `${skipped} tool policy record(s) ignored: reserved separator in name/source.`
					: undefined,
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
		?? await loadToolSearchPoliciesAt(legacyToolSearchConfigPath(cwd))
		?? { policies: new Map() };
}

export async function loadEffectiveToolSearchPolicies(
	cwd: string,
	trusted: boolean,
	agentDir = getAgentDir(),
): Promise<LoadedToolSearchPolicies> {
	const global = await loadToolSearchPoliciesAt(join(agentDir, CONFIG_FILE_NAME));
	const project = trusted ? await loadToolSearchPolicies(cwd) : undefined;
	return {
		policies: new Map([...(global?.policies ?? []), ...(project?.policies ?? [])]),
		projectPolicies: project?.policies,
		mode: project?.mode ?? global?.mode ?? "auto",
		audit: project?.audit ?? global?.audit ?? false,
		diagnostic: [global?.diagnostic, project?.diagnostic].filter(Boolean).join(" ") || undefined,
	};
}

export async function saveToolSearchPolicies(cwd: string, tools: ToolPolicyRecord[]): Promise<string> {
	const path = toolSearchConfigPath(cwd);
	// Reject what the loader must skip: a NUL-bearing record would write
	// successfully yet never round-trip (see loadToolSearchPoliciesAt).
	for (const record of tools) {
		if (record.name.includes("\u0000") || record.source.includes("\u0000")) {
			throw new Error("Tool-search policy records cannot contain NUL bytes in name/source.");
		}
	}
	const previous = await loadToolSearchPolicies(cwd);
	const config: ToolSearchProjectConfig = { version: CONFIG_VERSION, tools, mode: previous.mode, audit: previous.audit };
	const content = `${JSON.stringify(config, null, 2)}\n`;
	if (Buffer.byteLength(content, "utf8") > TOOL_SEARCH_CONFIG_MAX_BYTES) {
		throw new Error(`Tool-search policy exceeds ${TOOL_SEARCH_CONFIG_MAX_BYTES} bytes.`);
	}
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(tempPath, path);
		return path;
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

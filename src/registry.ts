import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export type ToolPolicy = "always" | "deferred" | "excluded";

export interface ToolPolicyRecord {
	name: string;
	source: string;
	policy: ToolPolicy;
}

export interface ToolCatalogEntry {
	key: string;
	tool: ToolInfo;
	policy: ToolPolicy;
	protected: boolean;
}

export const TOOL_SEARCH_NAME = "tool_search";
export const BASE_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const PROTECTED_TOOL_NAMES = new Set<string>([
	...BASE_TOOL_NAMES, TOOL_SEARCH_NAME, "contact_supervisor", "structured_output", "bg_wait",
]);
export const DEFAULT_EXCLUDED_TOOL_NAMES = new Set(["powershell"]);

// One lookup per winning provider path, never a filesystem walk per request.
const sourceIdentities = new Map<string, string>();
export function toolSourceIdentity(tool: Pick<ToolInfo, "sourceInfo">): string {
	const { source, path } = tool.sourceInfo;
	if (source === "builtin") return source;
	const cacheKey = `${source}\u0000${path}`;
	const cached = sourceIdentities.get(cacheKey);
	if (cached) return cached;
	let canonical = resolve(path);
	try { canonical = realpathSync(canonical); } catch { /* Unavailable providers retain a path identity. */ }
	const packagePath = canonical.replaceAll("\\", "/").split("/node_modules/").at(-1)!;
	const packageName = packagePath.startsWith("@")
		? packagePath.split("/").slice(0, 2).join("/")
		: packagePath.split("/")[0];
	const identity = canonical.replaceAll("\\", "/").includes("/node_modules/") && packageName
		? `npm:${packageName}`
		: source === "cli" || source === "local" || source.startsWith(".") || source.startsWith("/")
			? `file:${canonical}`
			: source;
	sourceIdentities.set(cacheKey, identity);
	return identity;
}

export function toolKey(tool: Pick<ToolInfo, "name" | "sourceInfo">): string {
	return `${toolSourceIdentity(tool)}\u0000${tool.name}`;
}

export function policyRecordKey(record: Pick<ToolPolicyRecord, "name" | "source">): string {
	return `${record.source}\u0000${record.name}`;
}

function defaultPolicy(tool: ToolInfo, initiallyActive: ReadonlySet<string>): ToolPolicy {
	if (PROTECTED_TOOL_NAMES.has(tool.name)) return "always";
	if (DEFAULT_EXCLUDED_TOOL_NAMES.has(tool.name)) return "excluded";
	return initiallyActive.has(tool.name) ? "deferred" : "excluded";
}

function entrySignature(entry: ToolCatalogEntry): string {
	return JSON.stringify([entry.key, entry.policy, entry.tool.description, entry.tool.parameters, entry.tool.promptGuidelines]);
}

export class ToolCatalog {
	private entriesByKey = new Map<string, ToolCatalogEntry>();
	private signature = "";

	refresh(
		tools: readonly ToolInfo[],
		initiallyActive: ReadonlySet<string>,
		savedPolicies: ReadonlyMap<string, ToolPolicy>,
		projectPolicies: ReadonlyMap<string, ToolPolicy> = new Map(),
	): boolean {
		const previous = this.signature;
		const next = new Map<string, ToolCatalogEntry>();
		for (const tool of tools) {
			const key = toolKey(tool);
			const protectedTool = PROTECTED_TOOL_NAMES.has(tool.name);
			const existing = this.entriesByKey.get(key);
			// Legacy source labels (notably "cli") remain readable. New saves use
			// canonical provider identities shared by parent and explicit child loads.
			const configured = projectPolicies.get(key)
				?? projectPolicies.get(`${tool.sourceInfo.source}\u0000${tool.name}`)
				?? savedPolicies.get(key)
				?? savedPolicies.get(`${tool.sourceInfo.source}\u0000${tool.name}`);
			const policy = protectedTool
				? "always"
				: configured ?? existing?.policy ?? defaultPolicy(tool, initiallyActive);
			next.set(key, { key, tool, policy, protected: protectedTool });
		}
		this.entriesByKey = next;
		const current = [...next.values()].map(entrySignature).sort().join("\n");
		this.signature = current;
		return previous !== current;
	}

	all(): ToolCatalogEntry[] {
		return [...this.entriesByKey.values()].sort(
			(left, right) =>
				Number(right.protected) - Number(left.protected) ||
				left.tool.sourceInfo.source.localeCompare(right.tool.sourceInfo.source) ||
				left.tool.name.localeCompare(right.tool.name),
		);
	}

	byName(name: string): ToolCatalogEntry | undefined {
		return [...this.entriesByKey.values()].find((entry) => entry.tool.name === name);
	}

	byKey(key: string): ToolCatalogEntry | undefined {
		return this.entriesByKey.get(key);
	}

	withPolicy(policy: ToolPolicy): ToolCatalogEntry[] {
		return this.all().filter((entry) => entry.policy === policy);
	}

	applyPolicies(policies: ReadonlyMap<string, ToolPolicy>): Set<string> {
		const changedNames = new Set<string>();
		for (const [key, policy] of policies) {
			const entry = this.entriesByKey.get(key);
			if (!entry || entry.protected || entry.policy === policy) continue;
			entry.policy = policy;
			changedNames.add(entry.tool.name);
		}
		return changedNames;
	}

	policyRecords(): ToolPolicyRecord[] {
		return this.all()
			.filter((entry) => !entry.protected)
			.map((entry) => ({
				name: entry.tool.name,
				source: toolSourceIdentity(entry.tool),
				policy: entry.policy,
			}));
	}
}

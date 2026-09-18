import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
// Invariant: this set IS the lock set. Every member is forced always and
// immutable in the config UI; everything else is user-configurable. Keep it
// to the tools that must stay visible: the minimal base set plus the loader.
export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set<string>(["read", "bash", "edit", "write", TOOL_SEARCH_NAME]);
// Plain defaults, not locks: every entry below stays user-configurable in the
// config UI and JSON. Only PROTECTED_TOOL_NAMES is immutable.
const DEFAULT_ALWAYS_TOOL_NAMES = new Set(["grep", "find", "ls"]);
const DEFAULT_EXCLUDED_TOOL_NAMES = new Set(["powershell"]);

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

/**
 * Normalize a raw extension/tool path the way Pi's loader does: expand `~`,
 * unwrap `file://`, resolve relatives against the session cwd. Pseudo-paths
 * such as `<builtin:read>` have no filesystem meaning and compare literally.
 */
export function normalizeExtensionPath(rawPath: string, cwd = process.cwd()): string {
	const candidate = rawPath.trim();
	if (candidate.startsWith("file://")) {
		try {
			return resolve(fileURLToPath(candidate));
	} catch { /* Fall through to plain normalization. */ }
	}
	const expanded = candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")
		? homedir() + candidate.slice(1)
		: candidate;
	if (expanded.startsWith("<") && expanded.endsWith(">")) return expanded;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** Single shared ownership check: UI labels and loader collision use this. */
export function isOwnedBy(
	tool: Pick<ToolInfo, "sourceInfo">,
	extensionPath: string,
	cwd = process.cwd(),
): boolean {
	return normalizeExtensionPath(tool.sourceInfo.path, cwd)
		=== normalizeExtensionPath(extensionPath, cwd);
}

/** Deterministic code-point ordering: identical on every machine and locale. */
function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function policyRecordKey(record: Pick<ToolPolicyRecord, "name" | "source">): string {
	return `${record.source}\u0000${record.name}`;
}

function defaultPolicy(tool: ToolInfo, initiallyActive: ReadonlySet<string>): ToolPolicy {
	if (DEFAULT_ALWAYS_TOOL_NAMES.has(tool.name)) return "always";
	if (DEFAULT_EXCLUDED_TOOL_NAMES.has(tool.name)) return "excluded";
	return initiallyActive.has(tool.name) ? "deferred" : "excluded";
}

function safeEntrySignature(entry: ToolCatalogEntry): string {
	try {
		return JSON.stringify([entry.key, entry.policy, entry.tool.description, entry.tool.parameters, entry.tool.promptGuidelines]);
	} catch {
		// Circular schemas or BigInt params must not break every lifecycle hook.
		return [entry.key, entry.policy, String(entry.tool.description ?? "")].join("\u0000");
	}
}

export class ToolCatalog {
	private entriesByKey = new Map<string, ToolCatalogEntry>();
	private signature = "";
	// Snapshot per key: field references are captured at cache time so that
	// in-place reassignment (tool.parameters = ...) is still detected. Only
	// deep mutation inside a retained object would slip through, which neither
	// Pi providers nor this extension perform.
	private signatureParts = new Map<string, {
		description: unknown;
		parameters: unknown;
		promptGuidelines: unknown;
		policy: ToolPolicy;
		signature: string;
	}>();

	refresh(
		tools: readonly ToolInfo[],
		initiallyActive: ReadonlySet<string>,
		savedPolicies: ReadonlyMap<string, ToolPolicy>,
		projectPolicies: ReadonlyMap<string, ToolPolicy> = new Map(),
	): boolean {
		const previous = this.signature;
		const next = new Map<string, ToolCatalogEntry>();
		const nextParts = new Map<string, {
			description: unknown;
			parameters: unknown;
			promptGuidelines: unknown;
			policy: ToolPolicy;
			signature: string;
		}>();
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
			const entry: ToolCatalogEntry = { key, tool, policy, protected: protectedTool };
			next.set(key, entry);
			// Reuse the cached signature when nothing it covers changed: the
			// snapshot holds the previous field references, so any reassigned
			// description/schema/guidelines object (or a policy change) misses
			// the cache. Steady state is O(n) reference comparisons instead of
			// re-serializing every JSON schema on every turn.
			const cached = this.signatureParts.get(key);
			const reusable = cached
				&& cached.description === tool.description
				&& cached.parameters === tool.parameters
				&& cached.promptGuidelines === tool.promptGuidelines
				&& cached.policy === policy
				? cached.signature
				: undefined;
			const signature = reusable ?? safeEntrySignature(entry);
			nextParts.set(key, {
				description: tool.description,
				parameters: tool.parameters,
				promptGuidelines: tool.promptGuidelines,
				policy,
				signature,
			});
		}
		this.entriesByKey = next;
		this.signatureParts = nextParts;
		const current = [...nextParts.values()].map((part) => part.signature).sort().join("\n");
		this.signature = current;
		return previous !== current;
	}

	all(): ToolCatalogEntry[] {
		return [...this.entriesByKey.values()].sort(
			(left, right) =>
				Number(right.protected) - Number(left.protected) ||
				compareStrings(left.tool.sourceInfo.source, right.tool.sourceInfo.source) ||
				compareStrings(left.tool.name, right.tool.name),
		);
	}

	byName(name: string): ToolCatalogEntry | undefined {
		// Single-winner rule shared with the name maps in applyMode/tool.ts:
		// last entry in all() order wins, so every lookup agrees on one provider.
		const entries = this.all();
		for (let index = entries.length - 1; index >= 0; index--) {
			if (entries[index].tool.name === name) return entries[index];
		}
		return undefined;
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

	policyRecords(overrides?: ReadonlyMap<string, ToolPolicy>): ToolPolicyRecord[] {
		return this.all()
			.filter((entry) => !entry.protected)
			.map((entry) => ({
				name: entry.tool.name,
				source: toolSourceIdentity(entry.tool),
				policy: overrides?.get(entry.key) ?? entry.policy,
			}));
	}
}

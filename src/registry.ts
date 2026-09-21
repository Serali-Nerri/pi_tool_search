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
export function toolSourceIdentity(tool: Pick<ToolInfo, "sourceInfo">, cwd = process.cwd()): string {
	const { source, path } = tool.sourceInfo;
	if (source === "builtin") return source;
	const normalized = normalizeExtensionPath(path, cwd);
	const cacheKey = `${source}\u0000${normalized}`;
	const cached = sourceIdentities.get(cacheKey);
	if (cached) return cached;
	const canonical = canonicalExtensionPath(normalized, cwd);
	const packagePath = canonical.replaceAll("\\", "/").split("/node_modules/").at(-1)!;
	const packageName = packagePath.startsWith("@")
		? packagePath.split("/").slice(0, 2).join("/")
		: packagePath.split("/")[0];
	// All SDK factories share source="inline". Pi's opaque factory path, not
	// that common tag, identifies the provider across reloads and resumes.
	const identity = source === "inline"
		? `inline:${canonical}`
		: canonical.replaceAll("\\", "/").includes("/node_modules/") && packageName
			? `npm:${packageName}`
			: source === "auto" || source === "cli" || source === "local" || source.startsWith(".") || source.startsWith("/")
				? `file:${canonical}`
				: source;
	sourceIdentities.set(cacheKey, identity);
	return identity;
}

export function toolKey(tool: Pick<ToolInfo, "name" | "sourceInfo">, cwd = process.cwd()): string {
	return `${toolSourceIdentity(tool, cwd)}\u0000${tool.name}`;
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

// Existing provider paths are stable for this extension instance. Share the
// realpath lookup between identity and ownership checks, not once per turn.
const canonicalPaths = new Map<string, string>();
function canonicalExtensionPath(rawPath: string, cwd: string): string {
	const normalized = normalizeExtensionPath(rawPath, cwd);
	if (normalized.startsWith("<") && normalized.endsWith(">")) return normalized;
	const cached = canonicalPaths.get(normalized);
	if (cached) return cached;
	try {
		const canonical = realpathSync(normalized);
		canonicalPaths.set(normalized, canonical);
		return canonical;
	} catch {
		// Do not cache failures: a dynamically registered provider may appear later.
		return normalized;
	}
}

/** Single shared ownership check: UI labels and loader collision use this. */
export function isOwnedBy(
	tool: Pick<ToolInfo, "sourceInfo">,
	extensionPath: string,
	cwd = process.cwd(),
): boolean {
	return canonicalExtensionPath(tool.sourceInfo.path, cwd)
		=== canonicalExtensionPath(extensionPath, cwd);
}

/** Deterministic code-point ordering: identical on every machine and locale. */
export function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function policyRecordKey(record: Pick<ToolPolicyRecord, "name" | "source">): string {
	return `${record.source}\u0000${record.name}`;
}

/** The NUL byte is the composite-key separator: a record carrying it could alias another tool's policy. */
export function hasReservedToolKeyPart(record: Pick<ToolPolicyRecord, "name" | "source">): boolean {
	return record.name.includes("\u0000") || record.source.includes("\u0000");
}

function defaultPolicy(tool: ToolInfo, initiallyActive: ReadonlySet<string>): ToolPolicy {
	if (DEFAULT_ALWAYS_TOOL_NAMES.has(tool.name)) return "always";
	if (DEFAULT_EXCLUDED_TOOL_NAMES.has(tool.name)) return "excluded";
	return initiallyActive.has(tool.name) ? "deferred" : "excluded";
}

function configuredPolicy(tool: ToolInfo, key: string, policies: ReadonlyMap<string, ToolPolicy>): ToolPolicy | undefined {
	const scoped = policies.get(key);
	if (scoped !== undefined) return scoped;
	// Generic inline/auto records cannot identify a provider. Retain only
	// exclusions, so moving to scoped identities cannot silently enable a tool.
	const source = tool.sourceInfo.source;
	const legacy = source === "inline" || (source === "auto" && key.startsWith("file:"));
	return legacy && policies.get(policyRecordKey({ source, name: tool.name })) === "excluded"
		? "excluded" : undefined;
}

// Identity tokens keep reassignment of an unserializable field detectable
// without serializing it: a fresh object gets a fresh token.
const fallbackTokens = new WeakMap<object, number>();
let nextFallbackToken = 0;

function fieldSignature(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		if (serialized !== undefined) return serialized;
	} catch { /* Circular schemas or BigInt params fall through to the token. */ }
	if ((typeof value === "object" && value !== null) || typeof value === "function") {
		let token = fallbackTokens.get(value);
		if (token === undefined) {
			token = ++nextFallbackToken;
			fallbackTokens.set(value, token);
		}
		return `\u0000token:${token}`;
	}
	return String(value);
}

function safeEntrySignature(entry: ToolCatalogEntry): string {
	// Per-field demotion: only the unserializable field degrades to its
	// identity token; the other fields keep full change detection.
	return [
		entry.key,
		entry.policy,
		fieldSignature(entry.tool.description),
		fieldSignature(entry.tool.parameters),
		fieldSignature(entry.tool.promptGuidelines),
	].join("\u0000");
}

interface SignatureSnapshot {
	description: unknown;
	parameters: unknown;
	promptGuidelines: unknown;
	policy: ToolPolicy;
	signature: string;
}

type CatalogEntry = ToolCatalogEntry & { snapshot: SignatureSnapshot; fallbackPolicy: ToolPolicy };

function compareEntries(left: CatalogEntry, right: CatalogEntry): number {
	return Number(right.protected) - Number(left.protected)
		|| compareStrings(left.tool.sourceInfo.source, right.tool.sourceInfo.source)
		|| compareStrings(left.tool.name, right.tool.name);
}

export class ToolCatalog {
	private entriesByKey = new Map<string, CatalogEntry>();
	private sortedEntries: CatalogEntry[] = [];
	private entriesByName = new Map<string, CatalogEntry>();
	private signature = "";

	constructor(private readonly cwd = process.cwd()) {}

	refresh(
		tools: readonly ToolInfo[],
		initiallyActive: ReadonlySet<string>,
		savedPolicies: ReadonlyMap<string, ToolPolicy>,
		projectPolicies: ReadonlyMap<string, ToolPolicy> = new Map(),
	): boolean {
		const previous = this.signature;
		const next = new Map<string, CatalogEntry>();
		for (const tool of tools) {
			const key = toolKey(tool, this.cwd);
			const protectedTool = PROTECTED_TOOL_NAMES.has(tool.name);
			const existing = this.entriesByKey.get(key);
			// Preserve the original default, not a former file override. Removing
			// a record must not leave its effective value stuck in the catalog.
			const fallbackPolicy = existing?.fallbackPolicy ?? defaultPolicy(tool, initiallyActive);
			const configured = configuredPolicy(tool, key, projectPolicies) ?? configuredPolicy(tool, key, savedPolicies);
			const policy = protectedTool ? "always" : configured ?? fallbackPolicy;
			// Reuse the cached signature when nothing it covers changed: the
			// snapshot holds the previous field references, so any reassigned
			// description/schema/guidelines object (or a policy change) misses
			// the cache. Steady state is O(n) reference comparisons instead of
			// re-serializing every JSON schema on every turn.
			const cached = existing?.snapshot;
			const signature = cached
				&& cached.description === tool.description
				&& cached.parameters === tool.parameters
				&& cached.promptGuidelines === tool.promptGuidelines
				&& cached.policy === policy
				? cached.signature
				: safeEntrySignature({ key, tool, policy, protected: protectedTool });
			// The snapshot lives on the entry so refresh() and applyPolicies()
			// update a single structure; only deep mutation inside a retained
			// object slips through, which neither Pi providers nor this
			// extension perform.
			next.set(key, {
				key,
				tool,
				policy,
				protected: protectedTool,
				fallbackPolicy,
				snapshot: {
					description: tool.description,
					parameters: tool.parameters,
					promptGuidelines: tool.promptGuidelines,
					policy,
					signature,
				},
			});
		}
		this.entriesByKey = next;
		const ordered = [...next.values()].sort(compareEntries);
		this.sortedEntries = ordered;
		// Single-winner rule: the last entry in all() order wins by Map
		// overwrite, matching applyMode's name map. Policy changes do not
		// affect ordering keys, so the index survives applyPolicies().
		this.entriesByName = new Map(ordered.map((entry) => [entry.tool.name, entry]));
		const current = ordered.map((entry) => entry.snapshot.signature).sort(compareStrings).join("\n");
		this.signature = current;
		return previous !== current;
	}

	all(): ToolCatalogEntry[] {
		return [...this.sortedEntries];
	}

	byName(name: string): ToolCatalogEntry | undefined {
		return this.entriesByName.get(name);
	}

	byKey(key: string): ToolCatalogEntry | undefined {
		return this.entriesByKey.get(key);
	}

	withPolicy(policy: ToolPolicy): ToolCatalogEntry[] {
		return this.sortedEntries.filter((entry) => entry.policy === policy);
	}

	applyPolicies(policies: ReadonlyMap<string, ToolPolicy>): Set<string> {
		const changedNames = new Set<string>();
		for (const [key, policy] of policies) {
			const entry = this.entriesByKey.get(key);
			if (!entry || entry.protected || entry.policy === policy) continue;
			entry.policy = policy;
			// Explicit in-memory overrides survive refresh without becoming file-layer state.
			entry.fallbackPolicy = policy;
			// Keep the signature snapshot in sync: refresh() reuses a cached
			// signature only when cached.policy matches, so a stale snapshot
			// would force a spurious change on the next refresh.
			entry.snapshot.policy = policy;
			entry.snapshot.signature = safeEntrySignature(entry);
			changedNames.add(entry.tool.name);
		}
		if (changedNames.size > 0) {
			this.signature = this.sortedEntries.map((entry) => entry.snapshot.signature).sort(compareStrings).join("\n");
		}
		return changedNames;
	}

	/** Serialize only the explicitly edited, registered, non-locked policies. */
	policyRecords(edits: ReadonlyMap<string, ToolPolicy>): ToolPolicyRecord[] {
		return this.all()
			.filter((entry) => !entry.protected && edits.has(entry.key))
			.map((entry) => ({
				name: entry.tool.name,
				source: toolSourceIdentity(entry.tool, this.cwd),
				policy: edits.get(entry.key)!,
			}));
	}
}

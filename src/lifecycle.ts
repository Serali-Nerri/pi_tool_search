import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getAgentDir, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import {
	loadEffectiveToolSearchPolicies,
	loadToolSearchPolicies,
	saveGlobalToolSearchPolicies,
	saveToolSearchPolicies,
	type LoadedToolSearchPolicies,
	type SavedToolSearchPolicies,
} from "./config.ts";
import {
	isOwnedBy,
	policyRecordKey,
	ToolCatalog,
	TOOL_SEARCH_NAME,
	type ToolPolicy,
} from "./registry.ts";
import { createToolSearchDefinition } from "./tool.ts";
import { showToolSearchConfig } from "./ui.ts";
import { supportsIncrementalTools } from "./capabilities.ts";
import { activationDetails, ActivationHistory, stringArray } from "./history.ts";
import { hasStandardToolMetadata, stabilizeToolMetadata, TOOLS_BLOCK_END, TOOLS_BLOCK_START } from "./prompt.ts";
import { RequestAudit } from "./audit.ts";

const TOOL_SEARCH_STATE_ENTRY = "pi-tool-search.state";
const TOOL_SEARCH_CORRECTIONS_ENTRY = "pi-tool-search.activation-corrections";

interface RestoredState {
	enabled: boolean;
	loaded: Set<string>;
	loadedKeys: Set<string>;
}

function restoredState(entries: readonly SessionEntry[]): RestoredState {
	let enabled = true;
	let stateIndex = -1;
	let savedLoaded: string[] = [];
	let savedKeys: string[] = [];
	for (const [index, entry] of entries.entries()) {
		if (entry.type !== "custom" || entry.customType !== TOOL_SEARCH_STATE_ENTRY) continue;
		const value = entry.data as { enabled?: unknown; loaded?: unknown; loadedKeys?: unknown } | undefined;
		if (typeof value?.enabled === "boolean") {
			enabled = value.enabled;
			savedKeys = stringArray(value.loadedKeys) ?? [];
			savedLoaded = savedKeys.length ? [] : stringArray(value.loaded) ?? [];
			stateIndex = index;
		}
	}
	const loaded = new Set<string>(enabled ? savedLoaded : []);
	const loadedKeys = new Set<string>(enabled ? savedKeys : []);
	if (!enabled) return { enabled, loaded, loadedKeys };
	for (const entry of entries.slice(stateIndex + 1)) {
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role !== "toolResult" || message.toolName !== TOOL_SEARCH_NAME || message.isError) continue;
			const details = activationDetails(message);
			if (details.loadedKeys) for (const key of details.loadedKeys) loadedKeys.add(key);
			else for (const name of details.active ?? details.added ?? message.addedToolNames ?? []) loaded.add(name);
		}
	}
	return { enabled, loaded, loadedKeys };
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((name, index) => name === right[index]);
}

export async function loadTrustedToolSearchPolicies(
	cwd: string,
	context: Pick<ExtensionContext, "isProjectTrusted">,
): Promise<LoadedToolSearchPolicies> {
	return context.isProjectTrusted()
		? loadToolSearchPolicies(cwd)
		: { policies: new Map() };
}

export async function saveToolSearchConfiguration(
	cwd: string,
	catalog: ToolCatalog,
	edits: ReadonlyMap<string, ToolPolicy>,
	scope: "global" | "project",
	agentDir = getAgentDir(),
): Promise<SavedToolSearchPolicies> {
	const candidates = catalog.policyRecords(edits);
	return scope === "global"
		? saveGlobalToolSearchPolicies(candidates, agentDir)
		: saveToolSearchPolicies(cwd, candidates);
}

export function registerToolSearch(pi: ExtensionAPI, cwd: string, extensionPath: string, agentDir = getAgentDir()): void {
	let catalog = new ToolCatalog(cwd);
	let globalPolicies = new Map<string, ToolPolicy>();
	let projectPolicies = new Map<string, ToolPolicy>();
	let enabled = true;
	let collision = false;
	let lastDescription: string | undefined;
	const loaded = new Map<string, string>();
	const hiddenByThisExtension = new Set<string>();
	// Pi only renders snippets for active tools and ToolInfo never exposes them,
	// so remember every snippet seen while its tool was still active. Deferred
	// tools keep their captured snippet until the session ends.
	const snippets = new Map<string, string>();
	const captureSnippets = (options?: { toolSnippets?: Record<string, string> }): void => {
		for (const [name, snippet] of Object.entries(options?.toolSnippets ?? {})) {
			const trimmed = snippet?.trim();
			if (trimmed) snippets.set(name, trimmed);
		}
	};
	// Pi hides deferred tools before before_agent_start ever sees them, so the
	// startup prompt (and every reload) is the only place their snippets exist.
	const captureSnippetsFromPrompt = (prompt: string | undefined): void => {
		if (!prompt) return;
		const start = prompt.indexOf(TOOLS_BLOCK_START);
		const end = prompt.indexOf(TOOLS_BLOCK_END);
		if (start < 0 || end < start) return;
		for (const line of prompt.slice(start + TOOLS_BLOCK_START.length, end).split("\n")) {
			const match = /^- ([A-Za-z0-9_.-]+): (.+)$/.exec(line.trim());
			if (match?.[2]?.trim()) snippets.set(match[1], match[2].trim());
		}
	};
	let mode: "auto" | "eager" = "auto";
	let native = false;
	let standardPrompt = true;
	let warnedTemplate = false;
	let auditEnabled = false;
	const history = new ActivationHistory();
	const audit = new RequestAudit();
	// Pi chooses native inline definitions or its normal active-list fallback.
	// Both transports support additive activation; only their cache behavior differs.
	const useDeferred = () => enabled && mode === "auto" && standardPrompt;

	const ownsLoader = (): boolean => {
		const tool = pi.getAllTools().find(({ name }) => name === TOOL_SEARCH_NAME);
		if (!tool) return false;
		// Session cwd, not process.cwd(): Pi resolves relative -e paths against
		// the session cwd, so `pi -e ./src/index.ts` still matches.
		return isOwnedBy(tool, extensionPath, cwd);
	};

	const deferredEntries = () => catalog.withPolicy("deferred");

	const activate = (names: string[]): { added: string[]; active: string[] } => {
		const activeBefore = pi.getActiveTools();
		const activeSet = new Set(activeBefore);
		const requested = names.filter((name) => catalog.byName(name)?.policy === "deferred");
		const additions = requested.filter((name) => !activeSet.has(name));
		if (additions.length > 0) pi.setActiveTools([...new Set([...activeBefore, ...additions])]);
		const activeAfter = new Set(pi.getActiveTools());
		const active = requested.filter((name) => activeAfter.has(name));
		const added = additions.filter((name) => activeAfter.has(name));
		for (const name of active) loaded.set(name, catalog.byName(name)!.key);
		return { added, active };
	};

	function registerLoader(force = false): void {
		if (!force && !ownsLoader()) return;
		const definition = createToolSearchDefinition({
			deferredEntries,
			enabled: useDeferred,
			owned: ownsLoader,
			activate,
			snippets: () => snippets,
		});
		if (!force && definition.description === lastDescription) return;
		lastDescription = definition.description;
		pi.registerTool(definition);
	}

	const applyMode = (): void => {
		collision = !ownsLoader();
		if (collision) {
			// Restore only tools this extension previously hid, without touching the
			// extension that now owns the loader name or its active-tool surface.
			const active = pi.getActiveTools();
			const restored = [...new Set([...active, ...hiddenByThisExtension])];
			if (!sameNames(active, restored)) pi.setActiveTools(restored);
			hiddenByThisExtension.clear();
			return;
		}
		const active = pi.getActiveTools();
		const entries = catalog.all();
		const byName = new Map(entries.map((entry) => [entry.tool.name, entry]));
		for (const [name, key] of loaded) {
			const entry = byName.get(name);
			if (entry?.key !== key || entry.policy !== "deferred") loaded.delete(name);
		}
		const finalNames = [...new Set([
			...entries.filter((entry) => entry.policy === "always"
				? useDeferred() || entry.tool.name !== TOOL_SEARCH_NAME
				: entry.policy === "deferred" && (!useDeferred() || loaded.has(entry.tool.name)))
				.map((entry) => entry.tool.name),
			...active.filter((name) => !byName.has(name)),
		])];
		const finalSet = new Set(finalNames);
		const hiddenThisPass = active.filter(
			(name) => byName.get(name)?.policy === "deferred" && !finalSet.has(name),
		);
		if (!sameNames(active, finalNames)) pi.setActiveTools(finalNames);
		const activeAfter = new Set(pi.getActiveTools());
		for (const name of hiddenThisPass) {
			if (!activeAfter.has(name)) hiddenByThisExtension.add(name);
		}
		for (const name of [...hiddenByThisExtension]) {
			if (activeAfter.has(name) || byName.get(name)?.policy !== "deferred") {
				hiddenByThisExtension.delete(name);
			}
		}
	};

	const refreshCatalog = (): boolean =>
		catalog.refresh(pi.getAllTools(), new Set(pi.getActiveTools()), globalPolicies, projectPolicies);

	const restoreForContext = (context: ExtensionContext): void => {
		const sessionManager = context.sessionManager as typeof context.sessionManager & {
			getBranch?: () => SessionEntry[];
		};
		const entries = sessionManager.getBranch?.() ?? context.sessionManager.buildContextEntries();
		const state = restoredState(entries);
		enabled = state.enabled;
		loaded.clear();
		history.reset();
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === TOOL_SEARCH_CORRECTIONS_ENTRY) history.restore(entry.data);
		}
		for (const name of state.loaded) {
			const entry = catalog.byName(name);
			if (entry?.policy === "deferred") loaded.set(name, entry.key);
		}
		for (const key of state.loadedKeys) {
			const entry = catalog.byKey(key);
			if (entry?.policy === "deferred") loaded.set(entry.tool.name, key);
		}
	};

	const statusText = (): string => {
		const deferred = catalog.withPolicy("deferred");
		const active = new Set(pi.getActiveTools());
		const loadedCount = deferred.filter((entry) => active.has(entry.tool.name)).length;
		return collision
			? "collision: another extension owns tool_search; no tools were deferred"
			: useDeferred()
				? `on · ${native ? "native" : "portable"} · ${deferred.length - loadedCount} deferred · ${loadedCount} loaded · ${catalog.withPolicy("always").length} always · ${catalog.withPolicy("excluded").length} excluded${native ? "" : " · loading changes the ordinary tools list; cache reuse may be affected"}`
				: `${enabled ? "eager" : "off"} · ${deferred.length} deferred tools restored · ${catalog.withPolicy("excluded").length} excluded · ${!enabled || mode === "eager" ? "explicit setting" : "custom/unrecognized prompt template"}`;
	};

	registerLoader(true);

	pi.on("session_start", async (_event, context) => {
		cwd = context.cwd || cwd;
		captureSnippetsFromPrompt(context.getSystemPrompt());
		catalog = new ToolCatalog(cwd);
		hiddenByThisExtension.clear();
		lastDescription = undefined;
		warnedTemplate = false;
		audit.reset();
		native = supportsIncrementalTools(context.model);
		standardPrompt = true;
		const config = await loadEffectiveToolSearchPolicies(cwd, context.isProjectTrusted(), agentDir);
		globalPolicies = config.globalPolicies ?? new Map();
		projectPolicies = config.projectPolicies ?? new Map();
		mode = config.mode ?? "auto";
		auditEnabled = config.audit === true || process.env.PI_TOOL_SEARCH_AUDIT === "1";
		refreshCatalog();
		restoreForContext(context);
		registerLoader();
		applyMode();

		if (collision && context.hasUI) {
			context.ui.notify(
				"pi-tool-search: tool_search name is owned by another extension; deferred mode was not applied.",
				"warning",
			);
		}

		if (config.diagnostic) {
			const message = `pi-tool-search: ${config.diagnostic}`;
			if (context.hasUI) context.ui.notify(message, "warning");
			else console.warn(message);
		}
	});

	pi.on("resources_discover", (_event, context) => {
		// Pi emits this after all session_start handlers, including providers
		// that register mode-dependent tools during startup or reload.
		captureSnippetsFromPrompt(context.getSystemPrompt());
		refreshCatalog();
		restoreForContext(context);
		registerLoader();
		applyMode();
	});

	pi.on("before_agent_start", (event, context) => {
		captureSnippets(event.systemPromptOptions);
		native = supportsIncrementalTools(context.model);
		standardPrompt = hasStandardToolMetadata(event.systemPrompt);
		if (refreshCatalog()) registerLoader();
		applyMode();
		if (collision) return;
		if (!standardPrompt) {
			if (enabled && mode === "auto" && !warnedTemplate) {
				warnedTemplate = true;
				const message = "pi-tool-search: custom/unrecognized system prompt; using fixed allowed tools. Use Pi's default prompt with append for deferred metadata.";
				if (context.hasUI) context.ui.notify(message, "warning");
				else console.warn(message);
			}
			return;
		}
		const options = event.systemPromptOptions;
		const systemPrompt = stabilizeToolMetadata(
			event.systemPrompt,
			options,
			catalog.all(),
			useDeferred(),
			event.systemPromptOptions,
		);
		return systemPrompt === undefined ? undefined : { systemPrompt };
	});

	pi.on("turn_end", (event) => {
		// Pi snapshots the next turn after this hook. Registry refreshes elsewhere
		// can reactivate the whole explicit allowlist; reassert our subset here.
		if (refreshCatalog()) registerLoader();
		applyMode();
		if (collision || !useDeferred()) return;
		const corrections = history.recordIncidental(event.toolResults, new Set(catalog.all().map((entry) => entry.tool.name)));
		if (corrections.length) pi.appendEntry(TOOL_SEARCH_CORRECTIONS_ENTRY, corrections);
	});

	pi.on("context", (event) => {
		if (!ownsLoader()) return;
		const messages = history.sanitize(event.messages);
		return messages === event.messages ? undefined : { messages };
	});

	pi.on("before_provider_request", (event) => {
		if (auditEnabled) console.warn(`pi-tool-search audit: ${audit.observe(event.payload)}`);
	});

	pi.on("model_select", (event) => {
		native = supportsIncrementalTools(event.model);
		refreshCatalog();
		applyMode();
	});

	pi.on("session_tree", (_event, context) => {
		captureSnippetsFromPrompt(context.getSystemPrompt());
		refreshCatalog();
		restoreForContext(context);
		registerLoader();
		applyMode();
	});

	pi.on("session_shutdown", () => {
		loaded.clear();
		snippets.clear();
		hiddenByThisExtension.clear();
		history.reset();
		audit.reset();
	});

	pi.registerCommand("tool-search", {
		description: "Configure deferred tools or inspect request fingerprints: /tool-search [config|config project|on|off|status|audit on|audit off|audit status]",
		getArgumentCompletions(prefix) {
			return ["config", "config project", "on", "off", "status", "audit on", "audit off", "audit status"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value }));
		},
		async handler(args, context) {
			const action = args.trim().toLowerCase() || "status";
			if (action.startsWith("audit")) {
				if (action === "audit on" || action === "audit off") {
					auditEnabled = action === "audit on";
					audit.reset();
				} else if (action !== "audit status" && action !== "audit") {
					context.ui.notify("Usage: /tool-search audit [on|off|status]", "warning");
					return;
				}
				context.ui.notify(`Request audit ${auditEnabled ? "on" : "off"}: ${audit.status()}. Structural checks do not measure server cache hits.`, "info");
				return;
			}
			if (!new Set(["config", "config project", "on", "off", "status"]).has(action)) {
				context.ui.notify("Usage: /tool-search [config|config project|on|off|status|audit on|audit off|audit status]", "warning");
				return;
			}
			if (action !== "status" && !context.isIdle()) {
				context.ui.notify("Wait for the current agent turn to finish before changing tool-search mode.", "warning");
				return;
			}
			if (action === "config" || action === "config project") {
				const scope = action === "config project" ? "project" : "global";
				if (scope === "project" && !context.isProjectTrusted()) {
					context.ui.notify("Project-local tool-search policy is unavailable until this project is trusted.", "warning");
					return;
				}
				refreshCatalog();
				const before = new Map(catalog.all().map((entry) => [entry.key, entry.policy]));
				const selected = await showToolSearchConfig(context, catalog.all(), extensionPath, cwd);
				if (!selected) return;
				const edits = new Map([...selected].filter(([key, policy]) => {
					const entry = catalog.byKey(key);
					return entry && !entry.protected && before.get(key) !== policy;
				}));
				if (edits.size === 0) {
					context.ui.notify("No tool policy changes to save.", "info");
					return;
				}
				if (!context.isIdle() || (scope === "project" && !context.isProjectTrusted())) {
					context.ui.notify("Tool-search policy was not saved: the session must be idle and project saves require trust.", "warning");
					return;
				}
				let saved: SavedToolSearchPolicies;
				try {
					saved = await saveToolSearchConfiguration(cwd, catalog, edits, scope, agentDir);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					context.ui.notify(`Failed to save tool-search policy: ${message}`, "error");
					return;
				}
				const { path, records, skipped } = saved;
				const savedLayer = new Map(records.map((record) => [policyRecordKey(record), record.policy]));
				if (scope === "global") globalPolicies = savedLayer;
				else projectPolicies = savedLayer;
				// Keep the layers separate. applyMode prunes loaded only after the
				// effective policy changes; a masked global edit must not unload it.
				refreshCatalog();
				registerLoader();
				applyMode();
				pi.appendEntry(TOOL_SEARCH_STATE_ENTRY, { enabled, loaded: [...loaded.keys()], loadedKeys: [...loaded.values()] });
				const changed = edits.size - skipped;
				context.ui.notify(`Saved ${changed} tool policy change${changed === 1 ? "" : "s"} to ${path}.`, "info");
				if (skipped > 0) {
					context.ui.notify(
						`${skipped} tool policy record(s) not saved or applied: reserved separator in name/source.`,
						"warning",
					);
				}
				if (scope === "global") {
					const overridden = [...edits].filter(([key, policy]) => {
						const entry = catalog.byKey(key);
						return entry && !entry.protected && savedLayer.get(key) === policy && entry.policy !== policy;
					}).length;
					if (overridden > 0) {
						context.ui.notify(
							`${overridden} saved change${overridden === 1 ? " is" : "s are"} overridden by project-level records and will not take effect in this project.`,
							"warning",
						);
					}
				}
				return;
			}
			if (action === "on" || action === "off") {
				enabled = action === "on";
				loaded.clear();
				applyMode();
				pi.appendEntry(TOOL_SEARCH_STATE_ENTRY, { enabled, loaded: [] });
			}
			context.ui.notify(`Tool search ${statusText()}.`, collision ? "warning" : "info");
		},
	});
}

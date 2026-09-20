import type { SessionEntry, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { TOOL_SEARCH_NAME } from "./registry.ts";

type ToolResult = TurnEndEvent["toolResults"][number];
export const TOOL_SEARCH_STATE_ENTRY = "pi-tool-search.state";
export const TOOL_SEARCH_GUIDANCE_MESSAGE = "pi-tool-search.guidance";

export function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...new Set(value)] : undefined;
}

export function activationDetails(message: ToolResult): {
	added?: string[]; active?: string[]; loadedKeys?: string[];
} {
	const details = message.details as { added?: unknown; active?: unknown; loadedKeys?: unknown } | undefined;
	return {
		added: stringArray(details?.added),
		active: stringArray(details?.active),
		loadedKeys: stringArray(details?.loadedKeys),
	};
}

/** Read-only migration boundary. Pi 0.86 never emits or consumes this old field. */
function legacyAddedToolNames(message: unknown): string[] | undefined {
	return message && typeof message === "object" && "addedToolNames" in message
		? stringArray(message.addedToolNames) : undefined;
}

/** Local intent is source-bound; upstream tool deltas contain schemas, not policy identities. */
export function restoredState(entries: readonly SessionEntry[]): {
	enabled: boolean; loaded: Set<string>; loadedKeys: Set<string>;
} {
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
			else for (const name of details.active ?? details.added ?? legacyAddedToolNames(message) ?? []) loaded.add(name);
		}
	}
	return { enabled, loaded, loadedKeys };
}

/** Inspect compacted context only on restore, not on every model request. */
export function pendingGuidanceCompaction(entries: readonly SessionEntry[]): string | undefined {
	let pending: string | undefined;
	for (const entry of entries) {
		if (entry.type === "compaction") pending = entry.id;
		if (entry.type === "custom_message" && entry.customType === TOOL_SEARCH_GUIDANCE_MESSAGE) {
			const details = entry.details as { compactionId?: unknown } | undefined;
			if (pending === details?.compactionId) pending = undefined;
		}
	}
	return pending;
}

import type { ContextEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { TOOL_SEARCH_NAME } from "./registry.ts";

type Message = ContextEvent["messages"][number];
type ToolResult = TurnEndEvent["toolResults"][number];

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

/**
 * Repair Pi's additive wrapper bookkeeping without changing stored transcripts.
 * Decisions for live non-loader results are captured once at turn_end, not
 * recomputed against future policies. No payload serialization or disk I/O.
 */
export class ActivationHistory {
	private corrections = new Map<string, string[]>();
	private cache = new WeakMap<Message, Message>();

	reset(): void {
		this.corrections.clear();
		this.cache = new WeakMap();
	}

	recordIncidental(results: readonly ToolResult[], managedNames: ReadonlySet<string>): Array<[string, string[]]> {
		const recorded: Array<[string, string[]]> = [];
		for (const message of results) {
			if (message.toolName === TOOL_SEARCH_NAME || !message.addedToolNames?.length) continue;
			const approved = message.addedToolNames.filter((name) => !managedNames.has(name));
			if (approved.length === message.addedToolNames.length) continue;
			this.corrections.set(message.toolCallId, approved);
			recorded.push([message.toolCallId, approved]);
			this.cache.delete(message);
		}
		return recorded;
	}

	restore(value: unknown): void {
		if (!Array.isArray(value)) return;
		for (const row of value) {
			if (!Array.isArray(row) || typeof row[0] !== "string") continue;
			const names = stringArray(row[1]);
			if (names) this.corrections.set(row[0], names);
		}
	}

	sanitize(messages: Message[]): Message[] {
		let changed = false;
		const next = messages.map((message) => {
			const cached = this.cache.get(message);
			if (cached) { changed ||= cached !== message; return cached; }
			let result = message;
			if (message.role === "toolResult" && message.addedToolNames?.length) {
				const approved = message.toolName === TOOL_SEARCH_NAME
					? message.isError ? [] : activationDetails(message).added
					: this.corrections.get(message.toolCallId);
				// Legacy loader results without structured details retain their records.
				if (approved) {
					const allowed = new Set(approved);
					const additions = message.addedToolNames.filter((name) => allowed.has(name));
					if (additions.length !== message.addedToolNames.length) {
						result = { ...message, addedToolNames: additions.length ? additions : undefined };
					}
				}
			}
			this.cache.set(message, result);
			changed ||= result !== message;
			return result;
		});
		return changed ? next : messages;
	}
}

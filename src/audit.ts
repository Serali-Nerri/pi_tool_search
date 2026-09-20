import { createHash } from "node:crypto";

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 16);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

function extendsHashes(previous: readonly string[], current: readonly string[]): boolean {
	return previous.every((item, index) => current[index] === item);
}

function systemPatch(item: Record<string, unknown>, anthropic: boolean): unknown {
	if (!anthropic || !Array.isArray(item.content)) return item;
	// Anthropic moves the message-cache breakpoint as the conversation grows.
	// Ignore only block-level transport markers, never text or tool schemas.
	return { ...item, content: item.content.map((value) => {
		const block = record(value);
		if (!block) return value;
		const { cache_control: _cacheControl, ...content } = block;
		return content;
	}) };
}

interface Snapshot {
	format: "responses" | "anthropic" | "completions";
	tools: string[];
	system: string;
	patches: string[];
	inline: string[];
}

/** Opt-in structural checks; stores hashes only, never issues requests or measures cache hits. */
export class RequestAudit {
	private previous?: Snapshot;
	private count = 0;
	private result = "no requests observed";

	reset(): void {
		this.previous = undefined;
		this.count = 0;
		this.result = "no requests observed";
	}

	observe(payload: unknown, api?: string): string {
		const body = record(payload);
		const responses = Array.isArray(body?.input);
		const messages = Array.isArray(body?.messages);
		if (!body || (!responses && !messages)
			|| (api !== undefined && !["openai-responses", "openai-codex-responses", "azure-openai-responses", "openai-completions", "anthropic-messages"].includes(api))) {
			this.previous = undefined;
			return this.result = "unsupported payload";
		}
		const format: Snapshot["format"] = responses ? "responses"
			: api === "anthropic-messages" || Object.hasOwn(body, "system") ? "anthropic" : "completions";
		const input = (responses ? body.input : body.messages) as unknown[];
		const tools = Array.isArray(body.tools) ? body.tools : [];
		const first = record(input[0]);
		const systemRole = (item: Record<string, unknown>) => ["developer", "system"].includes(String(item.role));
		// Codex instructions and Anthropic system live outside the conversation.
		// Their inline system messages are ALWAYS patches, including the first item.
		const separateSystem = Object.hasOwn(body, "instructions") || format === "anthropic";
		const leadingSystem = !separateSystem && first && systemRole(first) && first.type !== "additional_tools" ? first : undefined;
		const current: Snapshot = {
			format,
			tools: tools.map(hash),
			system: hash([body.instructions, body.system, leadingSystem]),
			patches: [],
			inline: [],
		};
		for (const [index, value] of input.entries()) {
			const item = record(value);
			if (!item) continue;
			if (["additional_tools", "tool_search_call", "tool_search_output"].includes(String(item.type))) {
				current.inline.push(hash([index, item]));
			} else if (systemRole(item) && !(index === 0 && leadingSystem)) {
				// Includes Anthropic tool_addition/removal and Kimi tool-bearing messages.
				current.patches.push(hash([index, systemPatch(item, format === "anthropic")]));
			}
		}
		const previous = this.previous?.format === format ? this.previous : undefined;
		const deferredAppend = previous && format === "anthropic" && tools.length > previous.tools.length
			&& extendsHashes(previous.tools, current.tools)
			&& tools.slice(previous.tools.length).every((tool) => record(tool)?.defer_loading === true);
		const changes = previous ? [
			...((!extendsHashes(previous.tools, current.tools) || previous.tools.length !== current.tools.length) && !deferredAppend ? ["top-level tools changed"] : []),
			...(previous.system !== current.system ? ["initial system prefix changed"] : []),
			...(!extendsHashes(previous.patches, current.patches) ? ["historical system patches changed"] : []),
			...(!extendsHashes(previous.inline, current.inline) ? ["historical inline definitions changed"] : []),
		] : [];
		this.previous = current;
		this.result = `request ${++this.count}: ${previous ? changes.join(", ") || "checked prefix sections stable" : "baseline"}; format=${format}; tools=${hash(current.tools)}; system=${current.system}; patches=${current.patches.length}; inline=${current.inline.length}${deferredAppend ? "; deferred tool declarations appended" : ""}`;
		return this.result;
	}

	status(): string { return this.result; }
}

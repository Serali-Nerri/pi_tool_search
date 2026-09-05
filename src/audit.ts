import { createHash } from "node:crypto";

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 16);
}

/** Opt-in structural check. Stores hashes only; does not issue requests or log prompts. */
export class RequestAudit {
	private previous?: { tools: string; system: string; inline: string[] };
	private count = 0;
	private result = "no requests observed";

	reset(): void {
		this.previous = undefined;
		this.count = 0;
		this.result = "no requests observed";
	}

	observe(payload: unknown): string {
		if (!payload || typeof payload !== "object") return "unsupported payload";
		const body = payload as { tools?: unknown; input?: unknown[]; instructions?: unknown };
		if (!Array.isArray(body.input)) return "unsupported payload";
		const input = body.input.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
		const current = {
			tools: hash(body.tools ?? []),
			system: hash(body.instructions ?? input.filter((item) => ["developer", "system"].includes(String(item.role))
				&& item.type !== "additional_tools")),
			inline: body.input.flatMap((item, index) => {
				const value = item as { type?: string } | null;
				return value && ["additional_tools", "tool_search_output"].includes(value.type ?? "") ? [hash([index, item])] : [];
			}),
		};
		const previous = this.previous;
		const changes = previous ? [
			...(previous.tools !== current.tools ? ["top-level tools changed"] : []),
			...(previous.system !== current.system ? ["system metadata changed"] : []),
			...(previous.inline.some((item, index) => current.inline[index] !== item) ? ["historical inline definitions changed"] : []),
		] : [];
		this.previous = current;
		this.result = `request ${++this.count}: ${previous ? changes.join(", ") || "checked prefix sections stable" : "baseline"}; tools=${current.tools}; system=${current.system}; inline=${current.inline.length}`;
		return this.result;
	}

	status(): string { return this.result; }
}

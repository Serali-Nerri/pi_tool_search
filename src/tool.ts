import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { boundedToolSnippet, buildToolSearchDescription, shortToolDescription } from "./manifest.ts";
import { TOOL_SEARCH_NAME, type ToolCatalogEntry } from "./registry.ts";

export const TOOL_SEARCH_MAX_RESULTS = 5;
export const TOOL_GUIDANCE_MAX_BYTES = 8 * 1024;

export interface ToolSearchResultDetails {
	matches: string[];
	added: string[];
	active?: string[];
	loadedKeys?: string[];
	unknown: string[];
	collision?: boolean;
}

const toolSearchParameters = Type.Object(
	{
		tool_names: Type.Array(Type.String(), {
			minItems: 1,
			maxItems: TOOL_SEARCH_MAX_RESULTS,
			uniqueItems: true,
			description: "One to five exact deferred tool names from the tool_search manifest",
		}),
	},
	{ additionalProperties: false },
);

type ToolSearchParameters = Static<typeof toolSearchParameters>;

interface ToolSearchRenderState {
	result?: AgentToolResult<ToolSearchResultDetails>;
	isPartial?: boolean;
	isError?: boolean;
}

interface ToolSearchRenderStyle {
	accent: (text: string) => string;
	error: (text: string) => string;
	muted: (text: string) => string;
	success: (text: string) => string;
	title: (text: string) => string;
	warning: (text: string) => string;
}

const EMPTY_COMPONENT: Component = {
	render: () => [],
	invalidate: () => {},
};

function joinedNames(names: readonly string[], fallback = "deferred tools"): string {
	return names.length > 0 ? names.join(", ") : fallback;
}

/**
 * Guidance for tools the model just activated.
 *
 * Pi's getAllTools() omits promptSnippet and hides deferred tools from
 * before_agent_start options, so snippets are captured while the tools were
 * still active (see captureSnippets in lifecycle.ts). When a snippet is known it
 * labels the tool; otherwise the bounded rendered description stands in.
 * Whitespace is collapsed so a multiline guideline cannot masquerade as extra
 * bullets, and repeated guidance is emitted once per activation batch. The
 * system prompt is never rewritten for deferred tools, which keeps its prefix
 * byte-stable.
 */
export interface ToolGuidanceOptions {
	/** Prompt snippets captured while the tools were still active, keyed by tool name. */
	snippets?: ReadonlyMap<string, string>;
	maxBytes?: number;
}

export function buildToolGuidance(
	names: readonly string[],
	byName: ReadonlyMap<string, ToolCatalogEntry>,
	options: ToolGuidanceOptions = {},
): string {
	const maxBytes = options.maxBytes ?? TOOL_GUIDANCE_MAX_BYTES;
	const lines = ["Tool guidance:"];
	let usedBytes = Buffer.byteLength(`${lines[0]}\n`, "utf8");
	const seen = new Set<string>();
	for (const name of names) {
		const entry = byName.get(name);
		if (!entry) continue;
		const label = options.snippets?.get(name);
		const snippet = label ? boundedToolSnippet(label) : undefined;
		const heading = `- ${name}: ${snippet ?? shortToolDescription(entry.tool.description)}`;
		const headingBytes = Buffer.byteLength(`${heading}\n`, "utf8");
		if (usedBytes + headingBytes > maxBytes) continue;
		lines.push(heading);
		usedBytes += headingBytes;
		for (const raw of entry.tool.promptGuidelines ?? []) {
			const guide = raw.replace(/\s+/g, " ").trim();
			if (!guide || seen.has(guide)) continue;
			const line = `  - ${guide}`;
			const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
			if (usedBytes + lineBytes > maxBytes) continue;
			seen.add(guide);
			lines.push(line);
			usedBytes += lineBytes;
		}
	}
	return lines.length > 1 ? lines.join("\n") : "";
}

function resultText(result: AgentToolResult<ToolSearchResultDetails> | undefined): string {
	return (result?.content ?? [])
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map(({ text }) => text)
		.join("\n");
}

function completedToolSearchStatus(
	result: AgentToolResult<ToolSearchResultDetails> | undefined,
	isError: boolean,
): { marker: "error" | "success" | "warning"; text: string; names?: string; tail?: string } {
	const details = result?.details;
	const output = resultText(result);
	if (isError || details?.collision || /(?:disabled|unavailable)/i.test(output)) {
		return { marker: "error", text: output.split("\n")[0] || "Tool search failed" };
	}

	const added = details?.added ?? [];
	const matches = details?.matches ?? [];
	const active = details?.active ?? matches;
	const unknown = details?.unknown ?? [];
	const alreadyActive = active.filter((name) => !added.includes(name));
	if (added.length > 0) {
		const suffixes: string[] = [];
		if (alreadyActive.length > 0) suffixes.push(`already active: ${joinedNames(alreadyActive)}`);
		if (unknown.length > 0) suffixes.push(`unknown: ${joinedNames(unknown)}`);
		return {
			marker: unknown.length > 0 ? "warning" : "success",
			text: "Activated",
			names: joinedNames(added),
			tail: suffixes.length > 0 ? ` · ${suffixes.join(" · ")}` : undefined,
		};
	}
	if (alreadyActive.length > 0) {
		return {
			marker: unknown.length > 0 ? "warning" : "success",
			text: "Already active:",
			names: joinedNames(alreadyActive),
			tail: unknown.length > 0 ? ` · unknown: ${joinedNames(unknown)}` : undefined,
		};
	}
	if (unknown.length > 0) {
		return {
			marker: "error",
			text: `${unknown.length === 1 ? "Unknown deferred tool:" : "Unknown deferred tools:"}`,
			names: joinedNames(unknown),
		};
	}
	return { marker: "warning", text: "No deferred tools were activated" };
}

class ToolSearchCallComponent implements Component {
	private args: ToolSearchParameters = { tool_names: [] };
	private executionStarted = false;
	private expanded = false;
	private state: ToolSearchRenderState = {};
	private style: ToolSearchRenderStyle = {
		accent: (text) => text,
		error: (text) => text,
		muted: (text) => text,
		success: (text) => text,
		title: (text) => text,
		warning: (text) => text,
	};

	update(
		args: ToolSearchParameters,
		executionStarted: boolean,
		expanded: boolean,
		state: ToolSearchRenderState,
		style: ToolSearchRenderStyle,
	): void {
		this.args = args;
		this.executionStarted = executionStarted;
		this.expanded = expanded;
		this.state = state;
		this.style = style;
	}

	render(width: number): string[] {
		if (!this.executionStarted && !this.state.result && !this.state.isError) return [];
		const names = joinedNames(this.args.tool_names);
		const pending = this.state.isPartial !== false;
		let line: string;
		if (pending) {
			line = `${this.style.warning("●")} ${
				this.expanded
					? `${this.style.title(TOOL_SEARCH_NAME)}${this.style.muted(`(${names})`)}`
					: `${this.style.muted("Activating ")}${this.style.accent(names)}`
			}`;
		} else {
			const status = completedToolSearchStatus(this.state.result, this.state.isError ?? false);
			const marker = status.marker === "error"
				? this.style.error("✗")
				: status.marker === "warning"
					? this.style.warning("!")
					: this.style.success("✓");
			line = this.expanded
				? `${marker} ${this.style.title(TOOL_SEARCH_NAME)}${this.style.muted(`(${names})`)}`
				: `${marker} ${this.style.muted(status.text)}${status.names ? ` ${this.style.accent(status.names)}` : ""}${
					status.tail ? this.style.muted(status.tail) : ""
				}`;
		}
		return [truncateToWidth(line, Math.max(1, width), "…")];
	}

	invalidate(): void {}
}

class ToolSearchResultComponent implements Component {
	constructor(
		private readonly text: string,
		private readonly style: ToolSearchRenderStyle,
	) {}

	render(width: number): string[] {
		if (!this.text) return [];
		const available = Math.max(1, width - 4);
		const lines: string[] = [];
		let first = true;
		for (const sourceLine of this.text.split("\n")) {
			if (!sourceLine) continue;
			const wrapped = wrapTextWithAnsi(this.style.muted(sourceLine), available);
			for (const line of wrapped.length > 0 ? wrapped : [""]) {
				lines.push(`${first ? `  ${this.style.muted("⎿ ")}` : "    "}${line}`);
				first = false;
			}
		}
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
	}

	invalidate(): void {}
}

interface ToolSearchDefinitionOptions {
	deferredEntries: () => ToolCatalogEntry[];
	lookupEntries?: () => ToolCatalogEntry[];
	enabled: () => boolean;
	owned: () => boolean;
	activate: (names: string[]) => { added: string[]; active: string[] };
	/** Prompt snippets captured while the tools were still active. */
	snippets?: () => ReadonlyMap<string, string>;
}

function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		let diagonal = previous[0];
		previous[0] = i;
		for (let j = 1; j <= right.length; j++) {
			const above = previous[j];
			previous[j] = Math.min(
				previous[j] + 1,
				previous[j - 1] + 1,
				diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
			);
			diagonal = above;
		}
	}
	return previous[right.length];
}

export function suggestToolNames(name: string, candidates: readonly string[], limit = 3): string[] {
	const normalized = name.toLowerCase();
	return candidates
		.map((candidate) => ({ candidate, distance: editDistance(normalized, candidate.toLowerCase()) }))
		.filter(({ candidate, distance }) =>
			distance <= Math.max(2, Math.floor(Math.max(normalized.length, candidate.length) * 0.4)),
		)
		.sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
		.slice(0, limit)
		.map(({ candidate }) => candidate);
}

export function createToolSearchDefinition(
	options: ToolSearchDefinitionOptions,
): ToolDefinition<typeof toolSearchParameters, ToolSearchResultDetails, ToolSearchRenderState> {
	const deferred = options.deferredEntries();
	return {
		name: TOOL_SEARCH_NAME,
		label: "Tool Search",
		description: buildToolSearchDescription(deferred),
		promptSnippet: "Activate deferred tools by exact name when the active tools cannot perform the task",
		promptGuidelines: ["Use tool_search when a needed capability is not currently available; call the loaded tool directly afterward."],
		parameters: toolSearchParameters,
		executionMode: "sequential",
		renderShell: "self",
		renderCall(args, theme, context) {
			context.state.isPartial = context.isPartial;
			context.state.isError = context.isError;
			const component = context.lastComponent instanceof ToolSearchCallComponent
				? context.lastComponent
				: new ToolSearchCallComponent();
			component.update(args, context.executionStarted, context.expanded, context.state, {
				accent: (text) => theme.fg("accent", text),
				error: (text) => theme.fg("error", text),
				muted: (text) => theme.fg("muted", text),
				success: (text) => theme.fg("success", text),
				title: (text) => theme.fg("toolTitle", theme.bold(text)),
				warning: (text) => theme.fg("warning", text),
			});
			return component;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			context.state.result = result;
			context.state.isPartial = isPartial;
			context.state.isError = context.isError;
			if (isPartial || !expanded) return EMPTY_COMPONENT;
			return new ToolSearchResultComponent(resultText(result), {
				accent: (text) => theme.fg("accent", text),
				error: (text) => theme.fg("error", text),
				muted: (text) => theme.fg("muted", text),
				success: (text) => theme.fg("success", text),
				title: (text) => theme.fg("toolTitle", theme.bold(text)),
				warning: (text) => theme.fg("warning", text),
			});
		},
		async execute(_toolCallId, params: ToolSearchParameters): Promise<AgentToolResult<ToolSearchResultDetails>> {
			if (!options.enabled()) {
				return {
					content: [{ type: "text", text: "Tool search mode is disabled. Use /tool-search on." }],
					details: { matches: [], added: [], unknown: [] },
				};
			}
			if (!options.owned()) {
				return {
					content: [{ type: "text", text: "Tool search is unavailable because its name is owned by another extension." }],
					details: { matches: [], added: [], unknown: [], collision: true },
				};
			}

			const entries = options.lookupEntries?.() ?? options.deferredEntries();
			const byName = new Map(entries.map((entry) => [entry.tool.name, entry]));
			const requested = [...new Set(params.tool_names)].slice(0, TOOL_SEARCH_MAX_RESULTS);
			const matches = requested.filter((name) => byName.has(name));
			const unknown = requested.filter((name) => !byName.has(name));
			const activation = options.activate(matches);
			const { added, active } = activation;
			const alreadyActive = active.filter((name) => !added.includes(name));
			const lines: string[] = [];
			if (added.length > 0) lines.push(`Loaded tools: ${added.join(", ")}`);
			if (alreadyActive.length > 0) lines.push(`Already active: ${alreadyActive.join(", ")}`);
			for (const name of unknown) {
				const suggestions = suggestToolNames(name, [...byName.keys()]);
				lines.push(
					suggestions.length > 0
						? `Unknown deferred tool: ${name}. Did you mean: ${suggestions.join(", ")}?`
						: `Unknown deferred tool: ${name}.`,
				);
			}
			const guidance = buildToolGuidance(added, byName, { snippets: options.snippets?.() });
			if (guidance) lines.push("", guidance);
			return {
				content: [{ type: "text", text: lines.join("\n") || "No deferred tools were loaded." }],
				details: { matches, added, active, unknown, loadedKeys: active.map((name) => byName.get(name)!.key) },
			};
		},
	};
}

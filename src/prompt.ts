import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { TOOL_SEARCH_NAME, type ToolCatalogEntry } from "./registry.ts";

/**
 * Pi's tool metadata markers. Deferred tools never contribute prompt metadata:
 * their capability summary lives in the loader manifest and their guidance
 * travels with the tool_search result (see buildToolGuidance in tool.ts), so the
 * system prompt stays byte-stable across activations.
 */
export const TOOLS_BLOCK_START = "\n\nAvailable tools:\n";
export const TOOLS_BLOCK_END = "\n\nIn addition to the tools above,";
const GUIDES_START = "\n\nGuidelines:\n";
const GUIDES_END = "\n\nPi documentation (";
const EXPLORATION_GUIDES = [
	"Use bash or PowerShell for file operations like listing, searching, and finding files",
	"Use PowerShell for file operations like listing, searching, and finding files",
	"Use bash for file operations like ls, rg, find",
];

function metadataBounds(prompt: string): number[] | undefined {
	const markers = [TOOLS_BLOCK_START, TOOLS_BLOCK_END, GUIDES_START, GUIDES_END];
	const positions = markers.map((marker) => prompt.indexOf(marker));
	if (positions.some((position, index) => position < 0
		|| prompt.indexOf(markers[index], position + 1) !== -1
		|| (index > 0 && position <= positions[index - 1]))) return undefined;
	return positions;
}

/**
 * Pi's tool metadata markers are the only signal we trust: subagent sessions
 * override the system prompt (customPrompt) but inherit a full copy of Pi's
 * prompt, tool list and guidelines included, so that copy must be rewritten
 * for the child's own tool set just like a top-level prompt.
 */
export function hasStandardToolMetadata(prompt: string): boolean {
	return metadataBounds(prompt) !== undefined;
}

/** Rewrite only known Pi metadata blocks. Role, safety, skills and project text stay current. */
export function stabilizeToolMetadata(
	prompt: string,
	options: BuildSystemPromptOptions,
	entries: readonly ToolCatalogEntry[],
	deferred: boolean,
	previousOptions: BuildSystemPromptOptions = options,
): string | undefined {
	const bounds = metadataBounds(prompt);
	if (!bounds) return undefined;
	const [toolStart, toolEnd, guideStart, guideEnd] = bounds;
	const visible = entries.filter((entry) => entry.policy === "always"
		? deferred || entry.tool.name !== TOOL_SEARCH_NAME
		: entry.policy === "deferred" && !deferred);
	const snippets = options.toolSnippets ?? {};
	const snippetFor = (name: string): string | undefined => {
		// Plain-object lookup must not match Object.prototype members: a tool
		// literally named "constructor" would otherwise inject native code.
		if (!Object.hasOwn(snippets, name)) return undefined;
		const value: unknown = snippets[name];
		return typeof value === "string" ? value : undefined;
	};
	const tools: string[] = [];
	for (const entry of visible) {
		const snippet = snippetFor(entry.tool.name);
		if (snippet !== undefined) tools.push(`- ${entry.tool.name}: ${snippet}`);
	}

	// Remove only exact, known tool metadata lines in a single pass. Unrecognized
	// guideline text from another extension is preserved, including changes
	// between user prompts.
	let remainder = `${prompt.slice(guideStart + GUIDES_START.length, guideEnd)}\n`;
	const removable = new Set<string>();
	for (const guide of [
		...EXPLORATION_GUIDES,
		...(previousOptions.promptGuidelines ?? []),
		...entries.flatMap((entry) => entry.tool.promptGuidelines ?? []),
	]) {
		const trimmed = guide.trim();
		if (trimmed) removable.add(`- ${trimmed}`);
	}
	if (removable.size > 0) {
		remainder = remainder.split("\n").filter((line) => !removable.has(line)).join("\n");
	}
	const guides = new Set<string>();
	const names = new Set(visible.map((entry) => entry.tool.name));
	if (!["grep", "find", "ls"].some((name) => names.has(name))) {
		if (names.has("bash") && names.has("powershell")) guides.add(EXPLORATION_GUIDES[0]);
		else if (names.has("powershell")) guides.add(EXPLORATION_GUIDES[1]);
		else if (names.has("bash")) guides.add(EXPLORATION_GUIDES[2]);
	}
	for (const entry of visible) {
		for (const guide of entry.tool.promptGuidelines ?? []) if (guide.trim()) guides.add(guide.trim());
	}
	const guidelineText = [...[...guides].map((guide) => `- ${guide}`), remainder.trimEnd()]
		.filter(Boolean).join("\n");
	return prompt.slice(0, toolStart) + TOOLS_BLOCK_START + (tools.join("\n") || "(none)")
		+ prompt.slice(toolEnd, guideStart) + GUIDES_START + guidelineText + prompt.slice(guideEnd);
}

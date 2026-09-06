import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { TOOL_SEARCH_NAME, type ToolCatalogEntry } from "./registry.ts";

export const DEFERRED_GUIDELINES_MAX_BYTES = 8 * 1024;
const TOOLS_START = "\n\nAvailable tools:\n";
const TOOLS_END = "\n\nIn addition to the tools above,";
const GUIDES_START = "\n\nGuidelines:\n";
const GUIDES_END = "\n\nPi documentation (";
const EXPLORATION_GUIDES = [
	"Use bash or PowerShell for file operations like listing, searching, and finding files",
	"Use PowerShell for file operations like listing, searching, and finding files",
	"Use bash for file operations like ls, rg, find",
];

function metadataBounds(prompt: string): number[] | undefined {
	const markers = [TOOLS_START, TOOLS_END, GUIDES_START, GUIDES_END];
	const positions = markers.map((marker) => prompt.indexOf(marker));
	if (positions.some((position, index) => position < 0
		|| prompt.indexOf(markers[index], position + 1) !== -1
		|| (index > 0 && position <= positions[index - 1]))) return undefined;
	return positions;
}

export function hasStandardToolMetadata(prompt: string, options?: BuildSystemPromptOptions): boolean {
	return !options?.customPrompt && metadataBounds(prompt) !== undefined;
}

/** Rewrite only known Pi metadata blocks. Role, safety, skills and project text stay current. */
export function stabilizeToolMetadata(
	prompt: string,
	options: BuildSystemPromptOptions,
	entries: readonly ToolCatalogEntry[],
	deferred: boolean,
	previousOptions: BuildSystemPromptOptions = options,
	activeToolNames: ReadonlySet<string> = new Set(options.selectedTools ?? []),
): string | undefined {
	if (options.customPrompt) return undefined;
	const bounds = metadataBounds(prompt);
	if (!bounds) return undefined;
	const [toolStart, toolEnd, guideStart, guideEnd] = bounds;
	const visible = entries.filter((entry) => entry.policy === "always"
		? deferred || entry.tool.name !== TOOL_SEARCH_NAME
		: entry.policy === "deferred" && !deferred);
	const snippets = options.toolSnippets ?? {};
	const tools = visible.filter((entry) => snippets[entry.tool.name])
		.map((entry) => `- ${entry.tool.name}: ${snippets[entry.tool.name]}`);

	// Remove only exact, known tool metadata. Unrecognized guideline text from
	// another extension is preserved, including changes between user prompts.
	let remainder = `${prompt.slice(guideStart + GUIDES_START.length, guideEnd)}\n`;
	const known = new Set([
		...EXPLORATION_GUIDES,
		...(previousOptions.promptGuidelines ?? []),
		...entries.flatMap((entry) => entry.tool.promptGuidelines ?? []),
	]);
	for (const guide of known) {
		if (!guide.trim()) continue;
		remainder = `\n${remainder}`.replaceAll(`\n- ${guide.trim()}\n`, "\n").slice(1);
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
	// Deferred tools contribute their own guidance only after activation. Before
	// that point their capability summary remains in the loader manifest, while
	// their full schema and prompt metadata stay out of the system prompt.
	let budget = DEFERRED_GUIDELINES_MAX_BYTES;
	if (deferred) for (const entry of entries.filter((entry) =>
		entry.policy === "deferred" && activeToolNames.has(entry.tool.name))) {
		for (const guide of entry.tool.promptGuidelines ?? []) {
			if (!guide.trim()) continue;
			const size = Buffer.byteLength(`- ${guide.trim()}\n`, "utf8");
			if (size > budget) continue;
			guides.add(guide.trim());
			budget -= size;
		}
	}
	const guidelineText = [...[...guides].map((guide) => `- ${guide}`), remainder.trimEnd()]
		.filter(Boolean).join("\n");
	return prompt.slice(0, toolStart) + TOOLS_START + (tools.join("\n") || "(none)")
		+ prompt.slice(toolEnd, guideStart) + GUIDES_START + guidelineText + prompt.slice(guideEnd);
}

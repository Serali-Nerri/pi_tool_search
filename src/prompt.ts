import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { TOOL_SEARCH_NAME, type ToolCatalogEntry } from "./registry.ts";

/** Opaque/custom tool sections belong to their author, not to this extension. */
export function hasStructuredToolMetadata(options: BuildSystemPromptOptions): boolean {
	return !options.customPrompt && options.forceSystemPrompt === undefined
		&& !Object.hasOwn(options.sections ?? {}, "tools")
		&& !Object.hasOwn(options.sections ?? {}, "rules");
}

/** Read all registered snippets, including inactive tools, from Pi 0.86's structured inputs. */
export function toolSnippets(options: BuildSystemPromptOptions): Map<string, string> {
	return new Map(Object.entries(options.toolSnippets ?? {})
		.filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1].trim())
		.map(([name, snippet]) => [name, snippet.trim()]));
}

export function toolGuidelines(options: BuildSystemPromptOptions): Map<string, readonly string[]> {
	return new Map(Object.entries(options.toolGuidelines ?? {})
		.filter(([, guides]) => Array.isArray(guides))
		.map(([name, guides]) => [name, guides.filter((guide) => typeof guide === "string")]));
}

/**
 * Only replace the two tool-owned sections, never the complete system prompt.
 * selectedTools remains the executable loadout. A stable display set also keeps
 * Pi's implicit shell-exploration rule stable when grep/find/ls are deferred.
 * All other sections, custom guidelines, project context and safety text survive.
 */
export function stabilizeToolMetadata(
	options: BuildSystemPromptOptions,
	entries: readonly ToolCatalogEntry[],
	deferred: boolean,
): void {
	const active = new Set(options.selectedTools ?? []);
	const visible = entries.filter((entry) => active.has(entry.tool.name) && (entry.policy === "always"
		? deferred || entry.tool.name !== TOOL_SEARCH_NAME
		: entry.policy === "deferred" && !deferred));
	const snippets = toolSnippets(options);
	const names = new Set(visible.map((entry) => entry.tool.name));
	const rules = new Set<string>();
	const addRule = (rule: string): void => { if (rule.trim()) rules.add(rule.trim()); };
	if (!["grep", "find", "ls"].some((name) => names.has(name))) {
		if (names.has("bash") && names.has("powershell")) addRule("Use bash or PowerShell for file operations like listing, searching, and finding files");
		else if (names.has("powershell")) addRule("Use PowerShell for file operations like listing, searching, and finding files");
		else if (names.has("bash")) addRule("Use bash for file operations like ls, rg, find");
	}
	for (const { tool } of visible) {
		const guides = options.toolGuidelines && Object.hasOwn(options.toolGuidelines, tool.name)
			? options.toolGuidelines[tool.name] : tool.promptGuidelines;
		for (const guide of guides ?? []) addRule(guide);
	}
	for (const guide of options.promptGuidelines ?? []) addRule(guide);
	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	const tools = visible.flatMap(({ tool }) => {
		const snippet = snippets.get(tool.name);
		return snippet ? [`- ${tool.name}: ${snippet}`] : [];
	});
	options.sections ??= {};
	options.sections.tools = `${tools.join("\n") || "(none)"}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
	options.sections.rules = [...rules].map((rule) => `- ${rule}`).join("\n");
}

import type { ToolCatalogEntry } from "./registry.ts";

export const TOOL_DESCRIPTION_MAX_BYTES = 160;
export const TOOL_MANIFEST_MAX_BYTES = 8 * 1024;

function utf8Prefix(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

function cleanDescription(description: string | null | undefined): string {
	return (description ?? "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
		.replace(/[`*#]+/g, "")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function firstSentence(text: string): string {
	const match = text.match(/^.*?[.!?。！？](?=\s|$|[A-Z\u4e00-\u9fff])/u);
	return match?.[0]?.trim() || text;
}

function clampToolText(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const ellipsis = "…";
	const prefix = utf8Prefix(text, Math.max(0, maxBytes - Buffer.byteLength(ellipsis, "utf8")));
	const boundary = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf(","), prefix.lastIndexOf(";"));
	const clipped = boundary >= Math.floor(prefix.length * 0.6) ? prefix.slice(0, boundary) : prefix;
	return `${clipped.trimEnd()}${ellipsis}`;
}

export function shortToolDescription(description: string | null | undefined, maxBytes = TOOL_DESCRIPTION_MAX_BYTES): string {
	const cleaned = firstSentence(cleanDescription(description));
	if (!cleaned) return "No description provided";
	return clampToolText(cleaned, maxBytes);
}

/**
 * Clean and bound a tool's promptSnippet for relocation into a tool result.
 * Pi normalizes snippets before rendering them, but extensions never see that
 * normalized value through getAllTools(), so repeat the cleaning here.
 */
export function boundedToolSnippet(snippet: string | null | undefined, maxBytes = TOOL_DESCRIPTION_MAX_BYTES): string | undefined {
	const cleaned = cleanDescription(snippet);
	return cleaned ? clampToolText(cleaned, maxBytes) : undefined;
}

export interface ToolManifest {
	text: string;
	listed: number;
	omitted: number;
}

export function buildToolManifest(
	entries: readonly ToolCatalogEntry[],
	maxBytes = TOOL_MANIFEST_MAX_BYTES,
): ToolManifest {
	const lines: string[] = [];
	let usedBytes = 0;
	for (const entry of entries) {
		const line = `- ${entry.tool.name} — ${shortToolDescription(entry.tool.description)}`;
		const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
		const remainingAfter = entries.length - lines.length - 1;
		const marker = `- … ${remainingAfter} additional deferred tools omitted from this bounded manifest`;
		const reserve = remainingAfter > 0 ? Buffer.byteLength(marker, "utf8") : 0;
		if (usedBytes + lineBytes + reserve > maxBytes) break;
		lines.push(line);
		usedBytes += lineBytes;
	}
	const omitted = entries.length - lines.length;
	if (omitted > 0) {
		const marker = `- … ${omitted} additional deferred tools omitted from this bounded manifest`;
		const available = Math.max(0, maxBytes - Buffer.byteLength(lines.join("\n"), "utf8") - (lines.length > 0 ? 1 : 0));
		lines.push(utf8Prefix(marker, available));
	}
	return { text: lines.join("\n"), listed: lines.length - (omitted > 0 ? 1 : 0), omitted };
}

export function buildToolSearchDescription(deferredEntries: readonly ToolCatalogEntry[]): string {
	const manifest = buildToolManifest(deferredEntries);
	return [
		"Activate deferred tools by exact name when a needed tool is not already available. This searches tool capabilities, not project files or text.",
		"Pass one to five exact tool_names from the manifest below. Pi provides full schemas after activation; call loaded tools directly.",
		"",
		"Available deferred tools:",
		manifest.text || "- (none)",
	].join("\n");
}

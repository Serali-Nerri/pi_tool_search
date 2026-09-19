import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { shortToolDescription } from "./manifest.ts";
import { isOwnedBy, normalizeExtensionPath, type ToolCatalogEntry, type ToolPolicy } from "./registry.ts";

const POLICY_VALUES: ToolPolicy[] = ["always", "deferred", "excluded"];

export function toolSearchEntryLabel(
	entry: ToolCatalogEntry,
	extensionPath: string,
	cwd = process.cwd(),
): string {
	return formatToolSearchEntryLabel(entry, isOwnedBy(entry.tool, extensionPath, cwd));
}

/** Shared row rendering: callers that already normalized the extension path
 * pass the ownership verdict directly to avoid re-resolving it per row. */
function formatToolSearchEntryLabel(entry: ToolCatalogEntry, owned: boolean): string {
	const owner = owned
		? "pi-tool-search"
		: entry.tool.sourceInfo.source;
	// The lock means exactly one thing: this row cannot be changed (forced
	// always). It tracks entry.protected one-to-one by design.
	return `${owner} · ${entry.tool.name}${entry.protected ? " 🔒" : ""}`;
}

export function sortConfigEntries(entries: readonly ToolCatalogEntry[]): ToolCatalogEntry[] {
	return [...entries].sort(
		(left, right) =>
			Number(right.protected) - Number(left.protected) ||
			Number(right.tool.sourceInfo.source === "builtin") - Number(left.tool.sourceInfo.source === "builtin"),
	);
}

export async function showToolSearchConfig(
	context: ExtensionCommandContext,
	entries: readonly ToolCatalogEntry[],
	extensionPath: string,
	cwd = process.cwd(),
): Promise<Map<string, ToolPolicy> | undefined> {
	if (context.mode !== "tui") {
		context.ui.notify("/tool-search config requires TUI mode", "error");
		return undefined;
	}
	const ordered = sortConfigEntries(entries);
	// Normalize the extension path once: every tool path still needs one
	// normalization per row (they differ per row), but the constant side of
	// the comparison must not be re-resolved for every row.
	const normalizedExtension = normalizeExtensionPath(extensionPath, cwd);
	const working = new Map(ordered.map((entry) => [entry.key, entry.policy]));
	return context.ui.custom<Map<string, ToolPolicy> | undefined>((tui, theme, _keybindings, done) => {
		const items: SettingItem[] = ordered.map((entry) => ({
			id: entry.key,
			label: formatToolSearchEntryLabel(
				entry,
				normalizeExtensionPath(entry.tool.sourceInfo.path, cwd) === normalizedExtension,
			),
			description: shortToolDescription(entry.tool.description),
			currentValue: entry.policy,
			values: entry.protected ? ["always"] : POLICY_VALUES,
		}));
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Tool Search Configuration")), 1, 1));
		const settingsList = new SettingsList(
			items,
			Math.min(Math.max(items.length, 1) + 2, 17),
			getSettingsListTheme(),
			(id, value) => working.set(id, value as ToolPolicy),
			() => done(new Map(working)),
			{ enableSearch: true },
		);
		container.addChild(settingsList);
		container.addChild(
			new Text(
				theme.fg("dim", "always = visible · deferred = load by name · excluded = unavailable · 🔒 = locked always · esc saves and closes"),
				1,
				1,
			),
		);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

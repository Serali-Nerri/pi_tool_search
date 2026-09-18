import { resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { shortToolDescription } from "./manifest.ts";
import type { ToolCatalogEntry, ToolPolicy } from "./registry.ts";

const POLICY_VALUES: ToolPolicy[] = ["always", "deferred", "excluded"];

export function toolSearchEntryLabel(entry: ToolCatalogEntry, extensionPath: string): string {
	const owner = resolve(entry.tool.sourceInfo.path) === resolve(extensionPath)
		? "pi-tool-search"
		: entry.tool.sourceInfo.source;
	// The lock means exactly one thing: this row cannot be changed (forced
	// always). It tracks entry.protected one-to-one by design.
	return `${owner} · ${entry.tool.name}${entry.protected ? " 🔒" : ""}`;
}

export function sortConfigEntries(entries: readonly ToolCatalogEntry[]): ToolCatalogEntry[] {
	return [...entries].sort(
		(left, right) => Number(right.tool.sourceInfo.source === "builtin") - Number(left.tool.sourceInfo.source === "builtin"),
	);
}

export async function showToolSearchConfig(
	context: ExtensionCommandContext,
	entries: readonly ToolCatalogEntry[],
	extensionPath: string,
): Promise<Map<string, ToolPolicy> | undefined> {
	if (context.mode !== "tui") {
		context.ui.notify("/tool-search config requires TUI mode", "error");
		return undefined;
	}
	const ordered = sortConfigEntries(entries);
	const working = new Map(ordered.map((entry) => [entry.key, entry.policy]));
	return context.ui.custom<Map<string, ToolPolicy> | undefined>((tui, theme, _keybindings, done) => {
		const items: SettingItem[] = ordered.map((entry) => ({
			id: entry.key,
			label: toolSearchEntryLabel(entry, extensionPath),
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

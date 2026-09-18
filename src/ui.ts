import { resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { shortToolDescription } from "./manifest.ts";
import { BASE_TOOL_NAMES, type ToolCatalogEntry, type ToolPolicy } from "./registry.ts";

const POLICY_VALUES: ToolPolicy[] = ["always", "deferred", "excluded"];
const BASE_TOOL_NAME_SET = new Set<string>(BASE_TOOL_NAMES);

export function toolSearchEntryLabel(
	entry: ToolCatalogEntry,
	extensionPath: string,
	configuredKeys: ReadonlySet<string> = new Set(),
): string {
	const owner = resolve(entry.tool.sourceInfo.path) === resolve(extensionPath)
		? "pi-tool-search"
		: entry.tool.sourceInfo.source;
	// The lock marks base tools (hardcoded) and tools the user pinned via
	// configuration. Behavioral protection (entry.protected) is separate and
	// intentionally unmarked.
	const locked = BASE_TOOL_NAME_SET.has(entry.tool.name) || configuredKeys.has(entry.key);
	return `${owner} · ${entry.tool.name}${locked ? " 🔒" : ""}`;
}

export async function showToolSearchConfig(
	context: ExtensionCommandContext,
	entries: readonly ToolCatalogEntry[],
	extensionPath: string,
	configuredKeys: ReadonlySet<string> = new Set(),
): Promise<Map<string, ToolPolicy> | undefined> {
	if (context.mode !== "tui") {
		context.ui.notify("/tool-search config requires TUI mode", "error");
		return undefined;
	}
	const working = new Map(entries.map((entry) => [entry.key, entry.policy]));
	return context.ui.custom<Map<string, ToolPolicy> | undefined>((tui, theme, _keybindings, done) => {
		const items: SettingItem[] = entries.map((entry) => ({
			id: entry.key,
			label: toolSearchEntryLabel(entry, extensionPath, configuredKeys),
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
				theme.fg("dim", "always = visible · deferred = load by name · excluded = unavailable · esc saves and closes"),
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

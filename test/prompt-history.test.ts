import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hasStructuredToolMetadata, stabilizeToolMetadata, toolSnippets } from "../src/prompt.ts";
import { pendingGuidanceCompaction, restoredState, stringArray, TOOL_SEARCH_GUIDANCE_MESSAGE } from "../src/history.ts";
import type { ToolCatalogEntry } from "../src/registry.ts";

function entry(name: string, policy: ToolCatalogEntry["policy"]): ToolCatalogEntry {
	return { key: `fixture\u0000${name}`, policy, protected: false, tool: {
		name, description: name, parameters: Type.Object({}), promptGuidelines: [`Use ${name}\n  with care.`],
		sourceInfo: { source: "fixture", path: "/fixture.ts", scope: "temporary", origin: "top-level" },
	} };
}
function options(selectedTools = ["read", "bash"]): BuildSystemPromptOptions {
	return {
		cwd: "/project", selectedTools,
		toolSnippets: { read: "Read files", bash: "Run commands", alpha: "Alpha research", grep: "Search", hidden: "Hidden" },
		toolGuidelines: { read: ["Read carefully"], alpha: ["Alpha guideline"] },
		promptGuidelines: ["Do not delete files", "Do not delete files"],
		contextFiles: [{ path: "/project/AGENTS.md", content: "Safety instructions" }],
		skills: [{
			name: "fixture", description: "Fixture skill", filePath: "/project/SKILL.md", baseDir: "/project",
			sourceInfo: { path: "/project/SKILL.md", source: "local", scope: "temporary", origin: "top-level" },
			disableModelInvocation: false,
		}],
		appendSystemPrompt: "Project role", sections: { task: "Current task" },
	};
}
const entries = [entry("read", "always"), entry("bash", "always"), entry("alpha", "deferred"), entry("grep", "deferred"), entry("hidden", "excluded")];

test("structured metadata stays identical across activation, including implicit exploration rules", () => {
	const before = options();
	const after = options(["read", "bash", "alpha", "grep"]);
	assert.equal(hasStructuredToolMetadata(before), true);
	const selected = after.selectedTools;
	stabilizeToolMetadata(before, entries, true);
	stabilizeToolMetadata(after, entries, true);
	assert.deepEqual(before.sections, after.sections);
	assert.equal(after.selectedTools, selected, "metadata projection must not disable executable tools");
	assert.doesNotMatch(JSON.stringify(after.sections), /Alpha|Hidden|Use grep|Use alpha/);
	assert.match(after.sections!.rules, /Use bash for file operations/);
	assert.equal(after.sections!.rules.match(/Do not delete files/g)?.length, 1);
	assert.equal(after.forceSystemPrompt, undefined);
});

test("all registered snippets are available before activation and unrelated context stays intact", () => {
	const input = { ...options(), customPrompt: "Safety role. Never delete files." };
	assert.equal(hasStructuredToolMetadata(input), true);
	const original = structuredClone(input);
	assert.equal(toolSnippets(input).get("alpha"), "Alpha research");
	stabilizeToolMetadata(input, entries, true);
	assert.equal(input.customPrompt, original.customPrompt);
	assert.deepEqual(input.contextFiles, original.contextFiles);
	assert.deepEqual(input.skills, original.skills);
	assert.equal(input.cwd, original.cwd);
	assert.equal(input.appendSystemPrompt, original.appendSystemPrompt);
	assert.equal(input.sections!.task, "Current task");
	assert.deepEqual(input.toolSnippets, original.toolSnippets);
	assert.deepEqual(input.promptGuidelines, original.promptGuidelines);
});

test("eager metadata includes allowed tools but excludes loader and excluded tools", () => {
	const input = options(["read", "bash", "alpha", "hidden", "tool_search"]);
	stabilizeToolMetadata(input, [...entries, entry("tool_search", "always")], false);
	assert.match(input.sections!.tools, /- alpha: Alpha research/);
	assert.match(input.sections!.rules, /Alpha guideline/);
	assert.doesNotMatch(JSON.stringify(input.sections), /tool_search|hidden/);
});

test("forced prompts and explicitly authored tools/rules sections remain opaque", () => {
	const extras: Partial<BuildSystemPromptOptions>[] = [
		{ forceSystemPrompt: "" },
		{ sections: { tools: "Authored tools" } }, { sections: { rules: "Authored rules" } },
	];
	for (const extra of extras) assert.equal(hasStructuredToolMetadata({ ...options(), ...extra }), false);
});

test("generic promptGuidelines survive even when identical text belongs to deferred or excluded tools", () => {
	const input = options();
	input.promptGuidelines = ["Alpha guideline", "Hidden guideline", "Authored rule"];
	input.toolGuidelines!.hidden = ["Hidden guideline"];
	const original = structuredClone(input.promptGuidelines);
	stabilizeToolMetadata(input, entries, true);
	assert.deepEqual(input.promptGuidelines, original);
	for (const guide of original) assert.ok(input.sections!.rules.includes(`- ${guide}`));
	assert.doesNotMatch(input.sections!.tools, /alpha|hidden/i);
});

test("multiline guidelines are preserved exactly once without string matching or prototype lookup", () => {
	const input = options(["constructor", "alpha"]);
	input.toolSnippets = {};
	input.toolGuidelines = {};
	input.promptGuidelines = ["Use alpha\n  with care."];
	stabilizeToolMetadata(input, [entry("constructor", "always"), entry("alpha", "always")], true);
	assert.equal(input.sections!.rules.match(/Use alpha/g)?.length, 1);
	assert.doesNotMatch(input.sections!.tools, /constructor|native code/);
});

test("restoration prefers source-bound intent and reads old addedToolNames only as a fallback", () => {
	const sm = SessionManager.inMemory("/fixture");
	const legacy = { role: "toolResult" as const, toolCallId: "old", toolName: "tool_search", content: [], addedToolNames: ["old_name"], isError: false, timestamp: 0 };
	const appendLegacy = (message: typeof legacy & { details?: { active?: string[]; added?: string[]; loadedKeys?: string[] } }) => sm.appendMessage(message);
	appendLegacy(legacy);
	appendLegacy({ ...legacy, toolCallId: "new", addedToolNames: ["wrong"], details: { active: ["wrong_name"], loadedKeys: ["npm:right\u0000alpha"] } });
	appendLegacy({ ...legacy, toolCallId: "empty", addedToolNames: ["should_not_restore"], details: { active: [], added: [] } });
	appendLegacy({ ...legacy, toolCallId: "failed", addedToolNames: ["failed"], isError: true });
	appendLegacy({ ...legacy, toolCallId: "foreign", toolName: "other", addedToolNames: ["foreign"] });
	sm.appendCustomEntry("pi-tool-search.activation-corrections", [["old", []]]);
	const original = structuredClone(sm.getEntries());
	const state = restoredState(sm.getBranch());
	assert.deepEqual([...state.loaded], ["old_name"]);
	assert.deepEqual([...state.loadedKeys], ["npm:right\u0000alpha"]);
	assert.deepEqual(sm.getEntries(), original);
});

test("latest local mode checkpoint controls restoration and failed/invalid state is ignored", () => {
	const sm = SessionManager.inMemory("/fixture");
	sm.appendCustomEntry("pi-tool-search.state", { enabled: true, loaded: ["alpha"], loadedKeys: ["source\u0000beta"] });
	assert.deepEqual([...restoredState(sm.getBranch()).loadedKeys], ["source\u0000beta"]);
	assert.deepEqual([...restoredState(sm.getBranch()).loaded], []);
	sm.appendCustomEntry("pi-tool-search.state", { enabled: false, loaded: ["alpha"] });
	assert.equal(restoredState(sm.getBranch()).enabled, false);
	assert.equal(restoredState(sm.getBranch()).loaded.size, 0);
	sm.appendCustomEntry("pi-tool-search.state", { enabled: true, loaded: [] });
	sm.appendCustomEntry("pi-tool-search.state", { enabled: "false", loaded: ["bad"] });
	assert.equal(restoredState(sm.getBranch()).enabled, true);
	assert.equal(restoredState(sm.getBranch()).loaded.size, 0);
	assert.equal(stringArray(["a", 1]), undefined);
	assert.equal(stringArray(null), undefined);
	assert.deepEqual(stringArray(["a", "a"]), ["a"]);
});

test("compaction guidance restoration is keyed to the latest compaction and survives branches", () => {
	const sm = SessionManager.inMemory("/fixture");
	const user = sm.appendMessage({ role: "user", content: "task", timestamp: 0 });
	assert.equal(pendingGuidanceCompaction(sm.buildContextEntries()), undefined);
	const compaction = sm.appendCompaction("summary", user, 1000);
	assert.equal(pendingGuidanceCompaction(sm.buildContextEntries()), compaction);
	sm.appendCustomMessageEntry(TOOL_SEARCH_GUIDANCE_MESSAGE, "guidance", false, { compactionId: "other" });
	assert.equal(pendingGuidanceCompaction(sm.buildContextEntries()), compaction);
	sm.appendCustomMessageEntry(TOOL_SEARCH_GUIDANCE_MESSAGE, "guidance", false, { compactionId: compaction });
	assert.equal(pendingGuidanceCompaction(sm.buildContextEntries()), undefined);
	sm.branch(compaction);
	assert.equal(pendingGuidanceCompaction(sm.buildContextEntries()), compaction);
});

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { globalToolSearchConfigPath } from "../src/config.ts";
import { hasStructuredToolMetadata } from "../src/prompt.ts";
import { TOOL_SEARCH_GUIDANCE_MESSAGE } from "../src/history.ts";
import { fixtureModel, sdkFixture, toolCall } from "./sdk-harness.ts";

// No provider, agent name or special marker is required for custom prefixes.
const customPrompt = "You are a research assistant.\n\n<role>Read-only. Never delete files.</role>";
const names = (request: TranscriptContext) => getCurrentTools(request.messages).map((tool) => tool.name);
const loaderResults = (f: Awaited<ReturnType<typeof sdkFixture>>) => f.session.messages
	.flatMap((message) => message.role === "toolResult" && message.toolName === "tool_search" ? [message] : []);

// Author-owned text, including tags and legacy headings, is never inspected
// for tool ownership. Only explicit structured tools/rules sections conflict.
const authoredText = [
	"Role\n<tools>Parent tools</tools>",
	"Role\n<rules>Parent rules</rules>",
	"Role\n< TOOLS >Parent tools</ TOOLS >",
	"Role\n</rules>",
	"Available tools:\n- parent: Legacy tool",
	"Role\r\n\tGuidelines:\r\n- Legacy guideline",
	"  Additional instructions without tags.  ",
];

test("only forced prompts and explicitly authored tools/rules sections prevent metadata management", () => {
	const input = { cwd: "/fixture", customPrompt };
	assert.equal(hasStructuredToolMetadata(input), true);
	assert.equal(hasStructuredToolMetadata({ cwd: "/fixture" }), true);
	const overrides: Partial<BuildSystemPromptOptions>[] = [
		{ forceSystemPrompt: "" }, { forceSystemPrompt: "Forced role" },
		{ sections: { tools: "" } }, { sections: { rules: "" } },
		{ sections: { tools: "Authored tools" } }, { sections: { rules: "Authored rules" } },
	];
	for (const extra of overrides) {
		const options: BuildSystemPromptOptions = { ...input, ...extra };
		const original = structuredClone(options);
		assert.equal(hasStructuredToolMetadata(options), false);
		assert.deepEqual(options, original);
	}
	assert.equal(hasStructuredToolMetadata({ ...input, sections: { task: "<tools>Keep this text</tools>" } }), true);
});

test("custom and append text have no bearing on structured tool ownership", () => {
	for (const text of authoredText) {
		const options = { cwd: "/fixture", customPrompt: text, appendSystemPrompt: text };
		const original = structuredClone(options);
		assert.equal(hasStructuredToolMetadata(options), true);
		assert.deepEqual(options, original);
	}
});

for (const [field, prefix] of [
	["customPrompt", customPrompt], ["appendSystemPrompt", customPrompt], ["appendSystemPrompt", undefined],
] as const) {
	test(`SDK preserves arbitrary ${field} text without changing tool policy (${prefix ? "custom prefix" : "default prompt"})`, async () => {
		let text = authoredText[0];
		const f = await sdkFixture({ customPrompt: prefix, beforeLoader: (pi) => {
			pi.on("before_agent_start", (event) => { event.systemPromptOptions[field] = text; });
		} });
		try {
			f.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })], [toolCall("alpha")]);
			for (const authored of authoredText) {
				text = authored;
				await f.session.prompt("preserve author text and manage only structured tool metadata");
				const request = f.requests.at(-1)!;
				assert.ok(names(request).includes("tool_search") && names(request).includes("alpha"));
				assert.ok(!names(request).includes("beta"));
				const sections = getCurrentSystemMessage(request.messages)?.sections;
				assert.equal(sections?.[field === "customPrompt" ? "preamble" : "addendum"], field === "customPrompt" ? text : `<addendum>\n${text}\n</addendum>`);
				assert.match(sections?.tools ?? "", /tool_search/);
				assert.doesNotMatch(sections?.rules ?? "", /Use alpha carefully|Use beta carefully/);
			}
			assert.ok(!names(f.requests[0]).includes("alpha"));
			assert.ok(f.session.messages.some((message) => message.role === "toolResult" && message.toolName === "alpha" && !message.isError));
			assert.deepEqual(f.errors, []);
		} finally { await f.cleanup(); }
	});
}

for (const native of [true, false]) {
	test(`SDK custom prefix supports first-load/use/repeat without rewriting the prefix (${native ? "native" : "portable"})`, async () => {
		const f = await sdkFixture({ customPrompt, model: fixtureModel("openai-responses", native) });
		try {
			f.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })], [toolCall("alpha")], [toolCall("tool_search", { tool_names: ["alpha"] })]);
			await f.session.prompt("load and use alpha, then repeat");
			assert.equal(f.requests.length, 4);
			const first = f.requests[0];
			assert.ok(names(first).includes("tool_search"));
			assert.ok(!names(first).includes("alpha") && !names(first).includes("beta"));
			const system = first.messages.find((message) => message.role === "system")!;
			assert.equal(system.sections?.preamble, customPrompt);
			assert.match(system.sections?.tools ?? "", /tool_search/);
			assert.doesNotMatch(system.sections?.rules ?? "", /Use alpha carefully|Use beta carefully/);
			const prompt = getCurrentSystemPrompt(first.messages);
			for (const request of f.requests.slice(1)) {
				assert.ok(names(request).includes("alpha") && !names(request).includes("beta"));
				assert.equal(getCurrentSystemPrompt(request.messages), prompt);
			}
			const delta = f.requests[1].messages.filter((message) => message.role === "system")[1];
			assert.deepEqual(delta.toolsAdded?.map((tool) => tool.name), ["alpha"]);
			assert.equal(delta.sections, undefined);
			const [firstResult, repeated] = loaderResults(f);
			assert.match(JSON.stringify(firstResult.content), /alpha structured snippet.*Use alpha carefully/);
			assert.doesNotMatch(JSON.stringify(repeated.content), /Tool guidance:/);
			assert.ok(f.session.messages.some((message) => message.role === "toolResult" && message.toolName === "alpha" && !message.isError));
			// A second prompt must not mistake our prior generated sections for authored ones.
			await f.session.prompt("continue");
			assert.equal(getCurrentSystemPrompt(f.requests.at(-1)!.messages), prompt);
			assert.ok(names(f.requests.at(-1)!).includes("tool_search"));
			assert.deepEqual(f.errors, []);
		} finally { await f.cleanup(); }
	});
}

test("SDK custom roles and unrelated structured context stay live while deferred metadata stays separate", async () => {
	let revision = 1;
	const role = () => `  Custom role ${revision}.\nNever delete files.\n`;
	const f = await sdkFixture({ customPrompt, beforeLoader: (pi) => {
		pi.on("before_agent_start", (event) => {
			const options = event.systemPromptOptions;
			options.customPrompt = role();
			options.appendSystemPrompt = `Append ${revision}`;
			options.contextFiles = [{ path: "/fixture/AGENTS.md", content: `Project safety ${revision}` }];
			options.promptGuidelines = [`Authored rule ${revision}`];
			options.sections = { task: `Task ${revision}` };
			options.toolSnippets.read = "Read fixture files";
			options.toolGuidelines.read = ["Use read for fixture files."];
		});
	} });
	try {
		f.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
		await f.session.prompt("load alpha with custom role");
		const initial = f.requests[0].messages.find((message) => message.role === "system")!;
		assert.equal(initial.sections?.preamble, role());
		assert.match(initial.sections?.tools ?? "", /Read fixture files/);
		assert.match(initial.sections?.rules ?? "", /Use read for fixture files/);
		assert.doesNotMatch(initial.sections?.tools ?? "", /alpha structured snippet/);
		assert.doesNotMatch(initial.sections?.rules ?? "", /Use alpha carefully/);
		revision++;
		await f.session.prompt("update only the role and project context");
		const last = f.requests.at(-1)!;
		const prompt = getCurrentSystemPrompt(last.messages);
		assert.ok(prompt.startsWith(role()));
		for (const text of ["Append 2", "Project safety 2", "Authored rule 2", "Task 2"]) assert.ok(prompt.includes(text));
		assert.doesNotMatch(prompt, /Custom role 1|Append 1|Project safety 1|Authored rule 1|Task 1|Use alpha carefully/);
		assert.ok(names(last).includes("alpha") && names(last).includes("tool_search"));
		assert.deepEqual(f.errors, []);
	} finally { await f.cleanup(); }
});

for (const policy of ["always", "deferred"] as const) {
	test(`SDK tool implementation overrides are not section ownership conflicts (${policy})`, async () => {
		const f = await sdkFixture({
			customPrompt, tools: ["read", "tool_search", "find", "alpha"],
			config: { version: 1, tools: [{ name: "find", source: "inline:<inline:fixture-before-loader>", policy }] },
			beforeLoader: (pi) => pi.registerTool({
				name: "find", label: "Custom find", description: "Overridden find implementation", parameters: Type.Object({}),
				promptSnippet: "Find using the custom implementation", promptGuidelines: ["Use find with the custom index."],
				async execute() { return { content: [{ type: "text", text: "custom find executed" }], details: {} }; },
			}),
		});
		try {
			if (policy === "deferred") f.responses.push([toolCall("tool_search", { tool_names: ["find"] })]);
			f.responses.push([toolCall("find")]);
			await f.session.prompt("use the overridden find tool");
			assert.ok(names(f.requests[0]).includes("tool_search"));
			assert.equal(names(f.requests[0]).includes("find"), policy === "always");
			const prompt = getCurrentSystemPrompt(f.requests[0].messages);
			assert.equal(prompt.includes("Find using the custom implementation"), policy === "always");
			assert.equal(prompt.includes("Use find with the custom index."), policy === "always");
			for (const request of f.requests) {
				assert.equal(getCurrentSystemPrompt(request.messages), prompt);
				assert.ok(!names(request).includes("alpha"));
			}
			if (policy === "deferred") assert.match(JSON.stringify(loaderResults(f)[0].content), /Find using the custom implementation.*Use find with the custom index/);
			assert.ok(f.session.messages.some((message) => message.role === "toolResult" && message.toolName === "find" && !message.isError && JSON.stringify(message.content).includes("custom find executed")));
			assert.deepEqual(f.errors, []);
		} finally { await f.cleanup(); }
	});
}

test("SDK custom prefix honors explicit eager/off and does not override eager on reset", async () => {
	for (const mode of ["eager", "off"] as const) {
		const f = await sdkFixture({ customPrompt, config: { version: 1, tools: [], mode: mode === "eager" ? "eager" : "auto" } });
		try {
			if (mode === "off") await f.session.prompt("/tool-search off");
			await f.session.prompt("inspect");
			assert.ok(!names(f.requests[0]).includes("tool_search"));
			assert.ok(names(f.requests[0]).includes("alpha"));
			assert.equal(f.requests[0].messages.find((message) => message.role === "system")?.sections?.preamble, customPrompt);
			await f.session.prompt("/tool-search on");
			await f.session.prompt("inspect after on");
			assert.equal(names(f.requests[1]).includes("tool_search"), mode === "off");
			assert.equal(names(f.requests[1]).includes("alpha"), mode === "eager");
			assert.deepEqual(f.errors, []);
		} finally { await f.cleanup(); }
	}
});

test("SDK custom prefix cannot load excluded tools or escape a child allowlist", async () => {
	const f = await sdkFixture({
		customPrompt, tools: ["read", "tool_search", "alpha", "beta"],
		config: { version: 1, tools: [
			{ name: "beta", source: "inline:<inline:fixture-provider>", policy: "excluded" },
			{ name: "write", source: "builtin", policy: "always" },
		] },
	});
	try {
		f.responses.push([toolCall("tool_search", { tool_names: ["alpha", "beta", "write"] })], [toolCall("alpha")]);
		await f.session.prompt("load only allowed tools");
		assert.deepEqual(new Set(names(f.requests[0])), new Set(["read", "tool_search"]));
		assert.doesNotMatch(getCurrentTools(f.requests[0].messages).find((tool) => tool.name === "tool_search")!.description, /beta|write/);
		for (const request of f.requests.slice(1)) assert.deepEqual(new Set(names(request)), new Set(["read", "tool_search", "alpha"]));
		assert.match(JSON.stringify(loaderResults(f)[0].details), /"unknown":\["beta","write"\]/);
		assert.ok(f.session.messages.some((message) => message.role === "toolResult" && message.toolName === "alpha" && !message.isError));
		assert.deepEqual(f.errors, []);
	} finally { await f.cleanup(); }
});

test("SDK custom prefix cannot manufacture a loader omitted from the child allowlist", async () => {
	const f = await sdkFixture({ customPrompt, tools: ["read", "alpha"] });
	try {
		await f.session.prompt("inspect");
		assert.deepEqual(new Set(names(f.requests[0])), new Set(["read", "alpha"]));
		assert.doesNotMatch(getCurrentSystemPrompt(f.requests[0].messages), /tool_search/);
		assert.deepEqual(f.errors, []);
	} finally { await f.cleanup(); }
});

test("SDK custom-prefix children and the structured parent keep independent activation state", async () => {
	const parent = await sdkFixture();
	const child = await sdkFixture({ customPrompt });
	const sibling = await sdkFixture({ customPrompt });
	try {
		parent.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
		await parent.session.prompt("parent loads alpha");
		child.responses.push([toolCall("tool_search", { tool_names: ["beta"] })]);
		await child.session.prompt("child loads beta");
		await sibling.session.prompt("sibling loads nothing");
		assert.ok(!names(child.requests[0]).includes("alpha"));
		assert.ok(!names(child.requests.at(-1)!).includes("alpha") && names(child.requests.at(-1)!).includes("beta"));
		assert.ok(!names(sibling.requests[0]).includes("alpha") && !names(sibling.requests[0]).includes("beta"));
		await parent.session.prompt("parent continues");
		assert.ok(names(parent.requests.at(-1)!).includes("alpha") && !names(parent.requests.at(-1)!).includes("beta"));
		for (const f of [parent, child, sibling]) assert.deepEqual(f.errors, []);
	} finally { await Promise.all([parent.cleanup(), child.cleanup(), sibling.cleanup()]); }
});

test("SDK custom prefix supports late registration, reload and policy reload without prompt mutation", async () => {
	const f = await sdkFixture({ customPrompt, tools: ["tool_search", "ls", "alpha", "beta", "late"] });
	try {
		f.responses.push([toolCall("ls")], [toolCall("tool_search", { tool_names: ["late"] })], [toolCall("late")]);
		await f.session.prompt("register and load late");
		for (const request of f.requests.slice(0, 2)) assert.deepEqual(new Set(names(request)), new Set(["tool_search", "ls"]));
		for (const request of f.requests.slice(2)) assert.deepEqual(new Set(names(request)), new Set(["tool_search", "ls", "late"]));
		await f.session.reload();
		// Reload recreated the provider, so load a startup-registered tool instead.
		f.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })], [toolCall("alpha")]);
		await f.session.prompt("load after reload");
		assert.ok(names(f.requests.at(-1)!).includes("alpha") && !names(f.requests.at(-1)!).includes("beta"));
		for (const request of f.requests) assert.equal(request.messages.find((message) => message.role === "system")?.sections?.preamble, customPrompt);
		await writeFile(globalToolSearchConfigPath(f.root), JSON.stringify({ version: 1, tools: [], mode: "eager" }));
		await f.session.reload();
		await f.session.prompt("inspect after switching to eager");
		assert.ok(!names(f.requests.at(-1)!).includes("tool_search"));
		assert.ok(names(f.requests.at(-1)!).includes("beta"));
		assert.deepEqual(f.errors, []);
	} finally { await f.cleanup(); }
});

test("SDK custom prefix activation survives resume and compaction, and respects tree branches", async () => {
	const f = await sdkFixture({ customPrompt });
	try {
		await f.session.prompt("base branch");
		const baseLeaf = f.sessionManager.getLeafId()!;
		f.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
		await f.session.prompt("load alpha");
		await f.session.prompt("keep this user turn");
		f.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 } });
		await f.session.compact();
		const resumed = await sdkFixture({ customPrompt, entries: structuredClone(f.sessionManager.getBranch()) });
		try {
			await resumed.session.prompt("resume after compaction");
			assert.ok(names(resumed.requests[0]).includes("alpha") && !names(resumed.requests[0]).includes("beta"));
			assert.ok(resumed.session.messages.some((message) => message.role === "custom" && message.customType === TOOL_SEARCH_GUIDANCE_MESSAGE));
			assert.ok(getCurrentSystemPrompt(resumed.requests[0].messages).startsWith(customPrompt));
			assert.deepEqual(resumed.errors, []);
		} finally { await resumed.cleanup(); }
		await f.session.navigateTree(baseLeaf, { summarize: false });
		await f.session.prompt("continue base branch");
		assert.ok(!names(f.requests.at(-1)!).includes("alpha"));
		assert.ok(names(f.requests.at(-1)!).includes("tool_search"));
		assert.deepEqual(f.errors, []);
	} finally { await f.cleanup(); }
});

test("SDK forced prompts and explicitly authored tool sections use eager without losing exclusions", async () => {
	const overrides: Partial<BuildSystemPromptOptions>[] = [
		{ forceSystemPrompt: "  Forced role\nNever delete files.  " },
		{ forceSystemPrompt: "" },
		{ sections: { tools: "Authored tools", task: "Keep task" } },
		{ sections: { rules: "Authored rules" } },
		{ sections: { tools: "" } },
		{ sections: { rules: "" } },
	];
	for (const override of overrides) {
		const f = await sdkFixture({
			customPrompt, tools: ["read", "tool_search", "alpha", "beta"],
			config: { version: 1, tools: [{ name: "beta", source: "inline:<inline:fixture-provider>", policy: "excluded" }] },
			beforeLoader: (pi) => {
				pi.on("before_agent_start", (event) => { Object.assign(event.systemPromptOptions, structuredClone(override)); });
			},
		});
		try {
			await f.session.prompt("inspect fallback");
			assert.deepEqual(new Set(names(f.requests[0])), new Set(["read", "alpha"]));
			const systems = f.requests[0].messages.filter((message) => message.role === "system");
			assert.equal(systems.length, 1);
			if (override.forceSystemPrompt !== undefined) {
				assert.equal(systems[0].content, override.forceSystemPrompt);
				assert.equal(systems[0].sections, undefined, "the exact forced text, not managed sections, reaches the model");
			} else {
				assert.equal(systems[0].sections?.preamble, customPrompt);
				for (const [name, content] of Object.entries(override.sections ?? {})) {
					assert.equal(systems[0].sections?.[name], content ? `<${name}>\n${content}\n</${name}>` : undefined);
				}
				if (!Object.hasOwn(override.sections ?? {}, "tools")) assert.equal(systems[0].sections?.tools, undefined);
				if (!Object.hasOwn(override.sections ?? {}, "rules")) assert.equal(systems[0].sections?.rules, undefined);
			}
			assert.deepEqual(f.errors, []);
		} finally { await f.cleanup(); }
	}
});

test("SDK returning a complete systemPrompt also forces exact text and eager, and removing it restores auto", async () => {
	const forced = "Exact replacement\n<tools>Author text</tools>\nNever delete files.";
	let force = true;
	const f = await sdkFixture({ customPrompt, beforeLoader: (pi) => {
		pi.on("before_agent_start", () => force ? { systemPrompt: forced } : undefined);
	} });
	try {
		await f.session.prompt("forced run");
		assert.equal(f.requests[0].messages.find((message) => message.role === "system")?.content, forced);
		assert.ok(!names(f.requests[0]).includes("tool_search") && names(f.requests[0]).includes("alpha"));
		force = false;
		await f.session.prompt("back to managed sections");
		assert.ok(names(f.requests[1]).includes("tool_search") && !names(f.requests[1]).includes("alpha"));
		assert.equal(getCurrentSystemMessage(f.requests[1].messages)?.sections?.preamble, customPrompt);
		assert.doesNotMatch(getCurrentSystemPrompt(f.requests[1].messages), /Exact replacement/);
		assert.deepEqual(f.errors, []);
	} finally { await f.cleanup(); }
});

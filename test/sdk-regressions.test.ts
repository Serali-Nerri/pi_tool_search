import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { activationDetails, TOOL_SEARCH_STATE_ENTRY } from "../src/history.ts";
import { toolKey } from "../src/registry.ts";
import { fixtureModel, sdkFixture, toolCall } from "./sdk-harness.ts";

const names = (context: TranscriptContext) => getCurrentTools(context.messages).map((tool) => tool.name);
const loaderResults = (fixture: Awaited<ReturnType<typeof sdkFixture>>) => fixture.session.messages
	.flatMap((message) => message.role === "toolResult" && message.toolName === "tool_search" ? [message] : []);

test("SDK named inline activation restores only for the same factory", async () => {
	const original = await sdkFixture({ providerName: "provider-A" });
	try {
		original.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
		await original.session.prompt("load alpha from provider A");
		const originalTool = original.session.getAllTools().find((tool) => tool.name === "alpha")!;
		const entries = structuredClone(original.sessionManager.getBranch());
		for (const providerName of ["provider-A", "provider-B"]) {
			const resumed = await sdkFixture({ providerName, entries });
			try {
				const sameProvider = providerName === "provider-A";
				const currentTool = resumed.session.getAllTools().find((tool) => tool.name === "alpha")!;
				assert.equal(toolKey(currentTool) === toolKey(originalTool), sameProvider);
				assert.equal(resumed.session.getActiveToolNames().includes("alpha"), sameProvider);
				await resumed.session.prompt("continue without authorizing a new provider");
				assert.equal(names(resumed.requests[0]).includes("alpha"), sameProvider);
				await resumed.session.reload();
				assert.equal(resumed.session.getActiveToolNames().includes("alpha"), sameProvider);
				assert.deepEqual(resumed.errors, []);
			} finally { await resumed.cleanup(); }
		}
		assert.deepEqual(original.errors, []);
	} finally { await original.cleanup(); }
});

test("SDK ambiguous legacy inline keys never fall back to unqualified loaded names", async () => {
	const original = await sdkFixture({ providerName: "provider-A" });
	try {
		original.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
		await original.session.prompt("load alpha");
		const legacyResults = structuredClone(original.sessionManager.getBranch());
		for (const entry of legacyResults) {
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "tool_search") {
				entry.message.details = { added: ["alpha"], active: ["alpha"], loadedKeys: ["inline\u0000alpha"] };
			}
		}
		original.sessionManager.appendCustomEntry(TOOL_SEARCH_STATE_ENTRY, {
			enabled: true, loaded: ["alpha"], loadedKeys: ["inline\u0000alpha"],
		});
		const legacyCheckpoint = structuredClone(original.sessionManager.getBranch());
		for (const entries of [legacyResults, legacyCheckpoint]) {
			const resumed = await sdkFixture({ providerName: "provider-B", entries });
			try {
				assert.ok(!resumed.session.getActiveToolNames().includes("alpha"));
				await resumed.session.prompt("inspect legacy state without loading alpha");
				assert.ok(!names(resumed.requests[0]).includes("alpha"));
				// Explicit loading still works and writes a new source-bound key.
				resumed.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
				await resumed.session.prompt("now authorize alpha from B");
				const result = loaderResults(resumed).at(-1)!;
				assert.deepEqual(activationDetails(result).loadedKeys, ["inline:<inline:provider-B>\u0000alpha"]);
				assert.deepEqual(resumed.errors, []);
			} finally { await resumed.cleanup(); }
		}
	} finally { await original.cleanup(); }
});

for (const native of [true, false]) {
	test(`SDK same-batch registration cannot suppress first-load guidance (${native ? "native" : "portable"})`, async () => {
		const f = await sdkFixture({ model: fixtureModel("openai-responses", native), tools: ["tool_search", "ls", "alpha", "beta", "late"] });
		try {
			// ls registers late and Pi temporarily reactivates the explicit allowlist.
			f.responses.push(
				[toolCall("ls"), toolCall("tool_search", { tool_names: ["alpha"] })],
				[toolCall("tool_search", { tool_names: ["alpha"] })],
			);
			await f.session.prompt("register a tool, load alpha in the same batch, then repeat the load");
			assert.equal(f.requests.length, 3);
			assert.deepEqual(new Set(names(f.requests[0])), new Set(["tool_search", "ls"]));
			for (const request of f.requests.slice(1)) {
				assert.deepEqual(new Set(names(request)), new Set(["tool_search", "ls", "alpha"]));
				assert.equal(getCurrentSystemPrompt(request.messages), getCurrentSystemPrompt(f.requests[0].messages));
			}
			const [first, repeated] = loaderResults(f);
			assert.match(JSON.stringify(first.content), /alpha structured snippet/);
			assert.match(JSON.stringify(first.content), /Use alpha carefully/);
			assert.deepEqual(activationDetails(first).added, ["alpha"]);
			assert.deepEqual(activationDetails(repeated).added, []);
			assert.doesNotMatch(JSON.stringify(repeated.content), /Tool guidance:/);
			assert.deepEqual(f.errors, []);
		} finally { await f.cleanup(); }
	});
}

test("SDK model-select registration refreshes the loader manifest without exposing unloaded tools", async () => {
	const f = await sdkFixture({
		tools: ["tool_search", "alpha", "beta", "model_tool"],
		beforeLoader: (pi) => {
			pi.on("model_select", (event) => {
				if (event.model.id !== "fixture-switched") return;
				pi.registerTool({
					name: "model_tool", label: "Model tool", description: "Model-specific capability", parameters: Type.Object({}),
					async execute() { return { content: [{ type: "text", text: "model tool executed" }], details: {} }; },
				});
			});
		},
	});
	try {
		f.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
		await f.session.prompt("load alpha before switching models");
		assert.doesNotMatch(f.session.getToolDefinition("tool_search")!.description, /model_tool/);
		await f.session.setModel({ ...fixtureModel(), id: "fixture-switched" });
		assert.match(f.session.getToolDefinition("tool_search")!.description, /model_tool — Model-specific capability/);
		assert.deepEqual(new Set(f.session.getActiveToolNames()), new Set(["tool_search", "alpha"]));
		await f.session.prompt("inspect the new manifest without loading anything");
		const tools = getCurrentTools(f.requests.at(-1)!.messages);
		assert.match(tools.find((tool) => tool.name === "tool_search")!.description, /model_tool — Model-specific capability/);
		assert.deepEqual(new Set(tools.map((tool) => tool.name)), new Set(["tool_search", "alpha"]));
		f.responses.push([toolCall("tool_search", { tool_names: ["model_tool"] })], [toolCall("model_tool")]);
		await f.session.prompt("load and execute the model-specific tool");
		assert.ok(f.session.messages.some((message) => message.role === "toolResult" && message.toolName === "model_tool" && !message.isError));
		assert.ok(!names(f.requests.at(-1)!).includes("beta"));
		assert.deepEqual(f.errors, []);
	} finally { await f.cleanup(); }
});

test("SDK fresh structured snippets survive idle tool-definition changes", async () => {
	const f = await sdkFixture();
	try {
		await f.session.prompt("initial turn without loading alpha");
		f.providerAPI.registerTool({
			...f.session.getToolDefinition("alpha")!,
			description: "Updated alpha description",
			promptSnippet: "Fresh alpha structured snippet",
			promptGuidelines: ["Use updated alpha guidelines."],
		});
		f.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
		await f.session.prompt("load alpha after its definition changed");
		const text = JSON.stringify(loaderResults(f)[0].content);
		assert.match(text, /Fresh alpha structured snippet/);
		assert.match(text, /Use updated alpha guidelines/);
		assert.doesNotMatch(text, /- alpha: alpha structured snippet|Use alpha carefully/);
		assert.deepEqual(f.errors, []);
	} finally { await f.cleanup(); }
});

for (const override of [[], ["Use the authored alpha guideline."]]) {
	test(`SDK fresh guideline overrides survive catalog invalidation (${override.length ? "authored" : "empty"})`, async () => {
		const f = await sdkFixture({ beforeLoader: (pi) => {
			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.toolGuidelines.alpha = [...override];
			});
		} });
		try {
			await f.session.prompt("initial turn without alpha");
			f.providerAPI.registerTool({
				...f.session.getToolDefinition("alpha")!,
				promptGuidelines: ["Registered replacement guideline."],
			});
			f.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
			await f.session.prompt("load alpha with the current authored guideline override");
			const text = JSON.stringify(loaderResults(f)[0].content);
			assert.doesNotMatch(text, /Registered replacement guideline/);
			if (override.length) assert.match(text, /Use the authored alpha guideline/);
			assert.deepEqual(f.errors, []);
		} finally { await f.cleanup(); }
	});
}

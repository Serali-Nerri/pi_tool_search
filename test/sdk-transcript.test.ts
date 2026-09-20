import assert from "node:assert/strict";
import test from "node:test";
import {
	getCurrentSystemPrompt, getCurrentTools, type Api, type JsonObject, type Model, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { TOOL_SEARCH_GUIDANCE_MESSAGE } from "../src/history.ts";
import { RequestAudit } from "../src/audit.ts";
import { fixtureModel, sdkFixture, toolCall } from "./sdk-harness.ts";

const names = (context: TranscriptContext) => getCurrentTools(context.messages).map((tool) => tool.name);
const systemMessages = (context: TranscriptContext) => context.messages.filter((message) => message.role === "system");

// Capture the actual adapter serialization and abort BEFORE network I/O.
async function payload(model: Model<Api>, context: TranscriptContext): Promise<JsonObject> {
	let captured: unknown;
	// Unsigned fixture JWT for Codex serialization only; never sent to a provider.
	const unsignedFixtureJwt = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.unsigned`;
	const result = await streamSimple(model, { messages: context.messages }, {
		apiKey: model.api === "openai-codex-responses" ? unsignedFixtureJwt : "fixture-not-a-real-key",
		transport: "sse", maxRetries: 0,
		onPayload(body) { captured = body; throw new Error("fixture-payload-captured"); },
	}).result();
	assert.ok(captured && typeof captured === "object", result.errorMessage);
	assert.match(result.errorMessage ?? "", /fixture-payload-captured/);
	return JSON.parse(JSON.stringify(captured)) as JsonObject;
}

for (const [api, native] of [
	["openai-responses", true], ["openai-codex-responses", true], ["anthropic-messages", true],
	["openai-completions", true], ["openai-completions", false],
] as const) {
	test(`SDK first request, activation, repeat and actual serialization: ${api} ${native ? "native" : "portable"}`, async () => {
		const model = fixtureModel(api, native);
		const f = await sdkFixture({ model });
		try {
			f.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })], [toolCall("alpha")], [toolCall("tool_search", { tool_names: ["alpha"] })]);
			await f.session.prompt("load and use alpha, then repeat");
			assert.deepEqual(f.errors, []);
			assert.equal(f.requests.length, 4);
			const [first, loaded, used, repeated] = f.requests;
			assert.ok(names(first).includes("tool_search"));
			assert.ok(!names(first).includes("alpha") && !names(first).includes("beta"));
			assert.ok(names(loaded).includes("alpha") && !names(loaded).includes("beta"));
			assert.deepEqual(names(repeated), names(loaded));
			const prompt = getCurrentSystemPrompt(first.messages);
			assert.match(prompt, /<tools>/);
			assert.doesNotMatch(prompt, /alpha structured snippet|Use alpha carefully/);
			for (const request of f.requests) assert.equal(getCurrentSystemPrompt(request.messages), prompt);
			assert.equal(systemMessages(first).length, 1);
			assert.equal(systemMessages(loaded).length, 2);
			assert.deepEqual(systemMessages(loaded)[1].toolsAdded?.map((tool) => tool.name), ["alpha"]);
			assert.equal(systemMessages(loaded)[1].sections, undefined);
			assert.deepEqual(systemMessages(used), systemMessages(repeated));
			const results = repeated.messages.filter((message) => message.role === "toolResult");
			assert.ok(results.every((result) => !result.isError && !("addedToolNames" in result)));
			assert.match(JSON.stringify(results[0].content), /alpha structured snippet.*Use alpha carefully/);
			assert.doesNotMatch(JSON.stringify(results.at(-1)?.content), /Tool guidance:/);

			const firstBody = await payload(model, first);
			const loadedBody = await payload(model, loaded);
			const audit = new RequestAudit();
			audit.observe(firstBody, api);
			const activationAudit = audit.observe(loadedBody, api);
			assert.match(activationAudit, native ? /stable/ : /top-level tools changed/);
			for (const request of [used, repeated]) assert.match(audit.observe(await payload(model, request), api), /stable/);
			if (!native) {
				assert.notDeepEqual(firstBody.tools, loadedBody.tools);
				assert.match(JSON.stringify(loadedBody.tools), /alpha/);
			} else if (api === "anthropic-messages") {
				assert.deepEqual(firstBody.system, loadedBody.system);
				assert.match(JSON.stringify(loadedBody.tools), /"name":"alpha".*"defer_loading":true/);
				assert.match(JSON.stringify(loadedBody.messages), /"type":"tool_addition","tool":\{"type":"tool_reference","name":"alpha"/);
			} else {
				assert.deepEqual(firstBody.tools, loadedBody.tools);
				assert.match(JSON.stringify(loadedBody.input ?? loadedBody.messages), api === "openai-codex-responses" ? /tool_search_output/ : api === "openai-responses" ? /additional_tools/ : /"tools":\[/);
				if (api === "openai-codex-responses") assert.equal(firstBody.instructions, loadedBody.instructions);
			}
		} finally { await f.cleanup(); }
	});
}

test("SDK explicit child allowlist and late registration never expose unrequested siblings", async () => {
	const f = await sdkFixture({ tools: ["tool_search", "ls", "alpha", "beta", "late"] });
	try {
		f.responses.push([toolCall("ls")], [toolCall("tool_search", { tool_names: ["late"] })]);
		await f.session.prompt("register and load late");
		assert.deepEqual(f.errors, []);
		assert.equal(f.requests.length, 3);
		assert.deepEqual(new Set(names(f.requests[0])), new Set(["tool_search", "ls"]));
		assert.deepEqual(new Set(names(f.requests[1])), new Set(["tool_search", "ls"]));
		assert.deepEqual(new Set(names(f.requests[2])), new Set(["tool_search", "ls", "late"]));
		assert.equal(getCurrentSystemPrompt(f.requests[0].messages), getCurrentSystemPrompt(f.requests[2].messages));
	} finally { await f.cleanup(); }
	const restricted = await sdkFixture({ tools: ["tool_search", "alpha"] });
	try {
		restricted.responses.push([toolCall("tool_search", { tool_names: ["alpha", "beta"] })]);
		await restricted.session.prompt("load allowed tools only");
		assert.ok(restricted.requests.every((request) => !names(request).includes("read") && !names(request).includes("beta")));
		assert.deepEqual(new Set(names(restricted.requests[1])), new Set(["tool_search", "alpha"]));
	} finally { await restricted.cleanup(); }
});

test("SDK activation survives reload/resume/model change and follows tree branches", async () => {
	const f = await sdkFixture();
	try {
		await f.session.prompt("base branch");
		const baseLeaf = f.sessionManager.getLeafId()!;
		f.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
		await f.session.prompt("loaded branch");
		const saved = structuredClone(f.sessionManager.getBranch());
		await f.session.reload();
		assert.ok(f.session.getActiveToolNames().includes("alpha"));
		await f.session.setModel(fixtureModel("openai-completions", false));
		assert.ok(f.session.getActiveToolNames().includes("alpha"));
		await f.session.prompt("after reload and model change");
		assert.ok(names(f.requests.at(-1)!).includes("alpha"));
		await f.session.navigateTree(baseLeaf, { summarize: false });
		assert.ok(!f.session.getActiveToolNames().includes("alpha"));
		await f.session.prompt("branched without activation");
		assert.ok(!names(f.requests.at(-1)!).includes("alpha"));
		const resumed = await sdkFixture({ entries: saved });
		try {
			assert.ok(resumed.session.getActiveToolNames().includes("alpha"));
			await resumed.session.prompt("continue loaded branch");
			assert.ok(names(resumed.requests[0]).includes("alpha"));
			assert.ok(!names(resumed.requests[0]).includes("beta"));
			assert.deepEqual(resumed.errors, []);
		} finally { await resumed.cleanup(); }
		assert.deepEqual(f.errors, []);
	} finally { await f.cleanup(); }
});

test("SDK compaction re-delivers bounded guidance without reloading tools or starting a model run", async () => {
	const f = await sdkFixture();
	try {
		f.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
		await f.session.prompt("load alpha");
		await f.session.prompt("retain this recent user turn");
		const requestCount = f.requests.length;
		f.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 } });
		await f.session.compact();
		assert.equal(f.requests.length, requestCount, "custom compaction and restoration make no model calls");
		assert.ok(f.session.getActiveToolNames().includes("alpha"));
		const beforeGuidance = structuredClone(f.sessionManager.getBranch());
		await f.session.prompt("continue after compaction");
		const compacted = f.sessionManager.buildSessionContext().messages;
		assert.ok(!compacted.some((message) => message.role === "toolResult" && message.toolName === "tool_search"));
		const guidance = compacted.flatMap((message) => message.role === "custom" && message.customType === TOOL_SEARCH_GUIDANCE_MESSAGE ? [message] : []);
		assert.equal(guidance.length, 1);
		assert.match(String(guidance[0].content), /Use alpha carefully/);
		assert.ok(Buffer.byteLength(String(guidance[0].content)) <= 8192);
		for (const entries of [beforeGuidance, structuredClone(f.sessionManager.getBranch())]) {
			const resumed = await sdkFixture({ entries });
			try {
				await resumed.session.prompt("continue compacted context");
				assert.ok(names(resumed.requests[0]).includes("alpha"));
				assert.equal(resumed.session.messages.filter((message) => message.role === "custom" && message.customType === TOOL_SEARCH_GUIDANCE_MESSAGE).length, 1);
			} finally { await resumed.cleanup(); }
		}
		assert.deepEqual(f.errors, []);
	} finally { await f.cleanup(); }
});

test("SDK mid-run compaction restores guidance immediately even with already-polled steering", async () => {
	let fixture: Awaited<ReturnType<typeof sdkFixture>>;
	fixture = await sdkFixture({ extension: (pi) => {
		pi.on("tool_result", (event) => {
			if (event.toolName !== "ls") return;
			fixture.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 99999 } });
			pi.sendMessage({ customType: "fixture-steer", content: "Continue the current task", display: false });
		});
		pi.on("session_compact", () => fixture.settingsManager.applyOverrides({ compaction: { enabled: false } }));
	} });
	try {
		fixture.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
		await fixture.session.prompt("load alpha");
		fixture.responses.push([toolCall("ls")]);
		await fixture.session.prompt("register a late fixture, then continue");
		assert.equal(fixture.requests.length, 4, "guidance must not cause a third response in the second run");
		const last = fixture.requests[3];
		assert.ok(!last.messages.some((message) => message.role === "toolResult" && message.toolName === "tool_search"));
		assert.match(JSON.stringify(last.messages), /Use alpha carefully/);
		assert.equal(fixture.session.messages.filter((message) => message.role === "custom" && message.customType === TOOL_SEARCH_GUIDANCE_MESSAGE).length, 1);
		assert.ok(names(last).includes("alpha") && !names(last).includes("late"));
		assert.deepEqual(fixture.errors, []);
	} finally { await fixture.cleanup(); }
});

test("SDK opaque parent/custom prompt is preserved and conservatively uses eager tools", async () => {
	const f = await sdkFixture({ customPrompt: "Parent role\n<tools>Parent-owned metadata</tools>\nNever delete files." });
	try {
		await f.session.prompt("inspect only");
		assert.ok(!names(f.requests[0]).includes("tool_search"));
		assert.ok(names(f.requests[0]).includes("alpha"));
		assert.match(getCurrentSystemPrompt(f.requests[0].messages), /Parent-owned metadata.*Never delete files/s);
	} finally { await f.cleanup(); }
});

test("real Responses serializer checkpoints tool removal and same-name schema replacement", async () => {
	const f = await sdkFixture();
	try {
		f.responses.push([toolCall("tool_search", { tool_names: ["alpha"] })]);
		await f.session.prompt("load alpha");
		f.providerAPI.registerTool({
			name: "alpha", label: "alpha", description: "alpha fixture", parameters: Type.Object({ value: Type.Optional(Type.String()) }),
			async execute() { return { content: [], details: {} }; },
		});
		await f.session.prompt("use the new schema");
		const replaced = await payload(fixtureModel(), f.requests.at(-1)!);
		assert.match(JSON.stringify(replaced.tools), /"name":"alpha".*"value"/);
		assert.doesNotMatch(JSON.stringify(replaced.input), /additional_tools|tool_search_output/);
		await f.session.prompt("/tool-search on");
		await f.session.prompt("reset loaded state");
		const removed = await payload(fixtureModel(), f.requests.at(-1)!);
		assert.ok(!names(f.requests.at(-1)!).includes("alpha"));
		assert.doesNotMatch(JSON.stringify(removed.tools), /"name":"alpha"/);
		assert.deepEqual(f.errors, []);
	} finally { await f.cleanup(); }
});

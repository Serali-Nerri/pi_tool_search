import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";

// Optional, local-only compatibility probe. It does not change installed packages
// or user configuration, and every model response comes from the loopback server.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piRoot = process.env.PROBE_PI_ROOT ?? "/home/thelya/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent";
const subagentsRoot = process.env.PROBE_SUBAGENTS_ROOT ?? "/home/thelya/.pi/agent/npm/node_modules/pi-subagents";
const fffRoot = process.env.PROBE_FFF_ROOT ?? "/home/thelya/.pi/agent/npm/node_modules/@ff-labs/pi-fff";
const webRoot = process.env.PROBE_WEB_ROOT ?? "/home/thelya/.pi/agent/npm/node_modules/pi-web-access";
const rtkPath = process.env.PROBE_RTK_ENTRY ?? "/home/thelya/.pi/agent/extensions/rtk.ts";
const docparserRoot = process.env.PROBE_DOCPARSER_ROOT ?? "/home/thelya/.pi/agent/npm/node_modules/pi-docparser";
const documentTools = ["document_parse", "document_search", "document_screenshot"];
const extensionPath = process.env.PROBE_TOOL_SEARCH_ENTRY ?? join(projectRoot, "src/index.ts");
const waitProfilePath = join(dirname(extensionPath), "profiles/bg-wait-always.ts");
const example = JSON.parse(await readFile(join(projectRoot, "docs/subagents-settings.example.json"), "utf8"));
const roleOverrides = example.subagents.agentOverrides;
function resolveRoleExtension(path: string): string {
	if (path.endsWith("/pi-tool-search/index.ts")) return extensionPath;
	if (path.endsWith("/extensions/rtk.ts")) return rtkPath;
	if (path.includes("/@ff-labs/pi-fff/")) return join(fffRoot, "src/index.ts");
	if (path.endsWith("/pi-web-access/index.ts")) return join(webRoot, "index.ts");
	if (path.endsWith("/pi-docparser/extensions/docparser/index.ts")) return join(docparserRoot, "extensions/docparser/index.ts");
	return path;
}
function peerEntry(modules: string, specifier: string): string {
	const parts = specifier.split("/");
	const packageName = parts.splice(0, specifier.startsWith("@") ? 2 : 1).join("/");
	const root = join(modules, packageName);
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const key = parts.length ? `./${parts.join("/")}` : ".";
	const entry = manifest.exports?.[key] ?? (key === "." ? manifest.main : undefined);
	const target = typeof entry === "string" ? entry : entry?.import ?? entry?.default;
	if (!target) throw new Error(`No direct import export: ${specifier}`);
	return resolve(root, target);
}
const aliases = new Map<string, string>([["@earendil-works/pi-coding-agent", join(piRoot, "dist/index.js")]]);
for (const name of ["@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "@earendil-works/pi-ai", "@earendil-works/pi-ai/compat", "@earendil-works/pi-ai/oauth", "typebox"]) {
	aliases.set(name, peerEntry(join(piRoot, "node_modules"), name));
}
// The installed Pi CLI supplies host aliases to extensions. Reproduce that
// resolution for the direct Node test entrypoint, including optional server peers.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (aliases.has(specifier)) return nextResolve(pathToFileURL(aliases.get(specifier)!).href, context);
		try { return nextResolve(specifier, context); }
		catch (error) {
			if (specifier.startsWith("@earendil-works/")) {
				for (const modules of [join(piRoot, "node_modules"), dirname(subagentsRoot)]) {
					try { return nextResolve(pathToFileURL(peerEntry(modules, specifier)).href, context); } catch {}
				}
			}
			throw error;
		}
	},
});
const probeRoot = await mkdtemp(join(tmpdir(), "pi-subagents-tool-search-"));
const agentDir = join(probeRoot, "agent");
await mkdir(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = piRoot;
process.env.PI_OFFLINE = "1";
delete process.env.PI_FFF_MODE;
await writeFile(join(agentDir, "pi-fff.json"), JSON.stringify({ mode: "override" }));
process.env.FFF_FRECENCY_DB = join(probeRoot, "fff-frecency");
process.env.FFF_HISTORY_DB = join(probeRoot, "fff-history");
delete process.env.PI_FFF_MULTIGREP;
await writeFile(join(agentDir, "settings.json"), JSON.stringify({
	packages: [], extensions: [], transport: "sse", retry: { enabled: false }, compaction: { enabled: false },
}));
await writeFile(join(agentDir, "pi-tool-search.json"), JSON.stringify({
	version: 1, mode: "auto", audit: false,
	tools: [
		...["web_search", "fetch_content", "get_search_content"].map((name) => ({ name, source: "npm:pi-web-access", policy: "deferred" })),
		...documentTools.map((name) => ({ name, source: "npm:pi-docparser", policy: "deferred" })),
	],
}));

const piModule = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
const { ProjectTrustStore } = await import(pathToFileURL(join(piRoot, "dist/core/trust-manager.js")).href);
const { createDefaultChildSessionFactory } = await import(pathToFileURL(join(subagentsRoot, "src/runs/shared/child-session.ts")).href);
const { createChildHooks } = await import(pathToFileURL(join(subagentsRoot, "src/runs/shared/child-hooks.ts")).href);

type Action = { name: string; args?: Record<string, unknown> } | { text: string };
type Scenario = {
	name: string;
	mode?: "additional" | "search" | "fallback";
	chatCompletions?: boolean;
	actions?: Action[];
	tools?: string[];
	fff?: boolean;
	sevenPolicy?: boolean;
	replacePrompt?: boolean;
	wrongCwd?: boolean;
	lateRegistration?: boolean;
	resume?: boolean;
	configRole?: string;
	inheritTools?: boolean;
	codex?: boolean;
	supervisor?: boolean;
	eager?: boolean;
	waitProfile?: boolean;
};
type Captured = { body: any; active: string[]; systemPrompt: string; catalog: any[] };
const requests = new Map<string, Captured[]>();
const sequences = new Map<string, Action[]>();
const pendingSnapshots = new Map<string, Omit<Captured, "body">[]>();
const transportErrors: string[] = [];
const results: any[] = [];
let responseCounter = 0;

const server = createServer(async (request, response) => {
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const bytes = Buffer.concat(chunks);
		const body = JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
		assert.equal(request.method, "POST");
		assert.ok(["/v1/responses", "/v1/codex/responses", "/v1/chat/completions"].includes(request.url ?? ""));
		const snapshot = pendingSnapshots.get(body.model)?.shift();
		assert.ok(snapshot, `Missing request observation for ${body.model}`);
		requests.get(body.model)!.push({ body, ...snapshot });
		const action = sequences.get(body.model)?.shift();
		assert.ok(action, `Unexpected model request for ${body.model}`);
		if ("name" in action) {
			assert.ok(snapshot.active.includes(action.name), `Script requested inactive tool ${action.name} in ${body.model}`);
			const definitions = [...(body.tools ?? []), ...inlineDefinitions(body)];
			assert.ok(JSON.stringify(definitions).includes(`"name":"${action.name}"`), `Missing wire definition for ${action.name} in ${body.model}`);
		}
		const serial = ++responseCounter;
		if (request.url === "/v1/chat/completions") {
			response.writeHead(200, { "content-type": "text/event-stream" });
			const delta = "name" in action
				? { role: "assistant", tool_calls: [{ index: 0, id: `call_${serial}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args ?? {}) } }] }
				: { role: "assistant", content: action.text };
			for (const chunk of [
				{ choices: [{ index: 0, delta, finish_reason: null }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: "name" in action ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 10, total_tokens: 1210 } },
			]) response.write(`data: ${JSON.stringify({ id: `chatcmpl_${serial}`, object: "chat.completion.chunk", created: 0, model: body.model, ...chunk })}\n\n`);
			response.end("data: [DONE]\n\n");
			return;
		}
		const item = "name" in action
			? { type: "function_call", id: `fc_${serial}`, call_id: `call_${serial}`, name: action.name, arguments: JSON.stringify(action.args ?? {}), status: "completed" }
			: { type: "message", id: `msg_${serial}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: action.text, annotations: [] }] };
		const envelope = { id: `resp_${serial}`, object: "response", status: "completed", output: [item], usage: { input_tokens: 1200, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } };
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const event of [
			{ type: "response.created", response: { ...envelope, status: "in_progress", output: [] } },
			{ type: "response.output_item.added", output_index: 0, item: "name" in action ? { ...item, arguments: "" } : { ...item, content: [] } },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: envelope },
		]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		response.end();
	} catch (error) {
		transportErrors.push(String(error));
		response.writeHead(500, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: String(error) } }));
	}
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const baseTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const permittedTools = [...baseTools, "tool_search", "probe_alpha", "probe_beta"];
const standardActions: Action[] = [
	{ name: "tool_search", args: { tool_names: ["probe_alpha"] } },
	{ name: "probe_alpha" },
	{ name: "tool_search", args: { tool_names: ["probe_alpha"] } },
	{ name: "probe_alpha" },
	{ text: "probe complete" },
];
const cases: Scenario[] = [
	{ name: "native-additional" },
	{ name: "codex-native", codex: true },
	{ name: "codex-fff-stable", codex: true, fff: true, sevenPolicy: true },
	{ name: "supervisor-stable", supervisor: true, tools: [...permittedTools, "contact_supervisor"] },
	{ name: "native-resume", resume: true },
	{ name: "native-inherit-tools", inheritTools: true },
	{ name: "native-search", mode: "search" },
	{ name: "native-metadata" },
	{ name: "late-registration", lateRegistration: true, tools: [...permittedTools, "probe_gamma"] },
	{ name: "non-native", mode: "fallback" },
	{ name: "portable-resume", mode: "fallback", resume: true },
	{ name: "portable-chat", mode: "fallback", chatCompletions: true },
	{ name: "portable-chat-resume", mode: "fallback", chatCompletions: true, resume: true },
	{ name: "eager-chat", mode: "fallback", chatCompletions: true, eager: true },
	{ name: "portable-late-registration", mode: "fallback", lateRegistration: true, tools: [...permittedTools, "probe_gamma"] },
	{ name: "portable-fff", mode: "fallback", fff: true, sevenPolicy: true },
	{ name: "explicit-eager", eager: true },
	{ name: "portable-explicit-eager", mode: "fallback", eager: true },
	{ name: "portable-replace-prompt", mode: "fallback", replacePrompt: true },
	{ name: "bg-wait-deferred", mode: "fallback", tools: [...permittedTools, "bg_wait"], actions: [
		{ name: "tool_search", args: { tool_names: ["bg_wait"] } },
		{ name: "bg_wait" },
		{ name: "tool_search", args: { tool_names: ["bg_wait"] } },
		{ text: "wait loaded once" },
	] },
	{ name: "bg-wait-native", tools: [...permittedTools, "bg_wait"], actions: [
		{ name: "tool_search", args: { tool_names: ["bg_wait"] } },
		{ name: "bg_wait" }, { text: "native wait loaded" },
	] },
	{ name: "wait-profile-missing-tool", waitProfile: true, tools: permittedTools, actions: [{ text: "role pin cannot grant a tool" }] },
	{ name: "allowlist-missing-target", tools: [...baseTools, "tool_search", "probe_beta"], actions: [{ name: "tool_search", args: { tool_names: ["probe_alpha"] } }, { text: "done" }] },
	{ name: "allowlist-missing-loader", tools: baseTools, actions: [{ text: "done" }] },
	{ name: "docparser-unloaded", actions: [{ name: "tool_search", args: { tool_names: documentTools } }, { text: "missing provider remains unavailable" }] },
	{ name: "fff-global-default", fff: true },
	{ name: "fff-seven-policy", fff: true, sevenPolicy: true },
	{ name: "fff-policy-migration", fff: true, sevenPolicy: true },
	{ name: "readonly", fff: true, sevenPolicy: true, tools: ["read", "grep", "find", "ls", "tool_search", "probe_alpha", "probe_beta"] },
	{ name: "fff-replace-prompt", fff: true, sevenPolicy: true, replacePrompt: true },
	{ name: "fff-different-child-cwd", fff: true, sevenPolicy: true, wrongCwd: true },
	...Object.keys(roleOverrides).map((role): Scenario => ({
		name: `configured-${role}`, configRole: role,
		mode: ["worker", "reviewer", "researcher"].includes(role) ? "fallback" : "additional",
		codex: ["scout", "delegate", "oracle"].includes(role),
		fff: role !== "researcher", supervisor: roleOverrides[role].tools.includes("contact_supervisor"),
		actions: [
			{ name: "tool_search", args: { tool_names: ["web_search"] } },
			...(roleOverrides[role].tools.includes("document_parse") ? [{ name: "tool_search", args: { tool_names: ["document_parse"] } }] : []),
			...(roleOverrides[role].tools.includes("bash") ? [{ name: "bash", args: { command: "git status --short" } }] : []),
			...(roleOverrides[role].tools.includes("document_parse") ? [{ name: "document_parse", args: { path: "fixture.pdf", targetPages: "1", ocr: "off" } }] : []),
			{ text: "configured role complete without external web requests" },
		],
	})),
	{ name: "docparser-readonly-native", configRole: "reviewer", codex: true, fff: true, supervisor: true, actions: [
		{ name: "tool_search", args: { tool_names: ["web_search", "document_parse"] } },
		{ name: "document_parse", args: { path: "fixture.pdf", targetPages: "1", ocr: "off" } },
		{ text: "native read-only document role complete" },
	] },
	{ name: "concurrent-loader" },
	{ name: "concurrent-idle", actions: [{ text: "independent child complete" }] },
	{ name: "concurrent-portable-loader", mode: "fallback" },
	{ name: "concurrent-portable-idle", mode: "fallback", actions: [{ text: "portable child stayed idle" }] },
	{ name: "concurrent-wait-pinned", waitProfile: true, tools: [...permittedTools, "bg_wait"], actions: [{ name: "bg_wait" }, { text: "role pin active" }] },
	{ name: "concurrent-wait-idle", mode: "fallback", tools: [...permittedTools, "bg_wait"], actions: [{ text: "default wait remains deferred" }] },
];
const models = cases.map((scenario) => ({
	id: scenario.name, name: scenario.name, reasoning: false, input: ["text"],
	api: scenario.chatCompletions ? "openai-completions" : scenario.codex ? "openai-codex-responses" : "openai-responses",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2000,
	compat: {
		supportsAdditionalTools: (scenario.mode ?? "additional") === "additional",
		supportsToolSearch: scenario.mode !== "fallback",
	},
}));
const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => piModule });

async function inspectConfigurationPlans(): Promise<any> {
	const { discoverAgents } = await import(pathToFileURL(join(subagentsRoot, "src/agents/agents.ts")).href);
	const { buildInProcessChildLaunch } = await import(pathToFileURL(join(subagentsRoot, "src/runs/shared/child-launch.ts")).href);
	const configCwd = join(probeRoot, "configuration");
	await mkdir(join(configCwd, ".pi"), { recursive: true });
	const overrides = structuredClone(roleOverrides);
	for (const role of Object.values(overrides) as any[]) {
		role.extensions = role.extensions.map(resolveRoleExtension);
	}
	await writeFile(join(configCwd, ".pi/settings.json"), JSON.stringify({ subagents: { defaultExtensions: example.subagents.defaultExtensions, agentOverrides: overrides } }));
	const discovered = discoverAgents(configCwd, "project");
	for (const agent of discovered.agents) {
		assert.ok(Array.isArray(agent.extensions), `${agent.name}: explicit or default extension list required`);
		assert.ok([...(agent.extensions ?? []), ...(agent.subagentOnlyExtensions ?? []), ...(agent.tools ?? [])].every((value: string) => !/pi-freeflow|doompi-autocompact/.test(value)), `${agent.name}: excluded extension selected`);
	}
	const plans: any[] = [];
	for (const name of Object.keys(overrides)) {
		const agent = discovered.agents.find((value: any) => value.name === name);
		assert.ok(agent, `Role ${name} must be discovered`);
		assert.equal(agent.systemPromptMode, "append");
		assert.ok(agent.tools.includes("tool_search"));
		assert.deepEqual(agent.extensions, overrides[name].extensions);
		for (const host of ["parent", "runner"]) {
			const launch = buildInProcessChildLaunch({ ...agent, host, cwd: configCwd, childAgentName: name, childIndex: 0, sessionEnabled: false });
			assert.ok(launch.session.tools.includes("tool_search"));
			assert.equal(launch.session.ambientExtensions, false);
			assert.ok(launch.session.extensionPaths.includes(extensionPath));
			assert.ok(launch.session.appendSystemPrompt);
			assert.equal(launch.session.extensionPaths.includes(rtkPath), agent.tools.includes("bash"));
			assert.equal(launch.session.extensionPaths.includes(join(docparserRoot, "extensions/docparser/index.ts")), agent.tools.includes("document_parse"));
			if (name === "reviewer") assert.ok(["bash", "edit", "write"].every((tool) => !launch.session.tools.includes(tool)));
			plans.push({ role: name, host, tools: launch.session.tools, extensionPaths: launch.session.extensionPaths, ambientExtensions: launch.session.ambientExtensions, promptMode: agent.systemPromptMode });
		}
	}
	const profileCwd = join(probeRoot, "wait-role-profile");
	await mkdir(join(profileCwd, ".pi"), { recursive: true });
	const waitRole = {
		...overrides.worker,
		tools: [...overrides.worker.tools, "bg_wait"],
		extensions: overrides.worker.extensions.map((path: string) => path === extensionPath ? waitProfilePath : path),
	};
	await writeFile(join(profileCwd, ".pi/settings.json"), JSON.stringify({ subagents: { defaultExtensions: [], agentOverrides: { worker: waitRole } } }));
	const profileAgent = discoverAgents(profileCwd, "project").agents.find((agent: any) => agent.name === "worker");
	assert.ok(profileAgent);
	const rolePolicyPlans: any[] = [];
	for (const host of ["parent", "runner"]) {
		const launch = buildInProcessChildLaunch({ ...profileAgent, host, cwd: profileCwd, childAgentName: "worker", childIndex: 0, sessionEnabled: false });
		assert.ok(launch.session.tools.includes("bg_wait"));
		assert.ok(launch.session.extensionPaths.includes(waitProfilePath));
		assert.ok(!launch.session.extensionPaths.includes(extensionPath));
		assert.equal(launch.session.ambientExtensions, false);
		rolePolicyPlans.push({ host, tools: launch.session.tools, extensionPaths: launch.session.extensionPaths });
	}
	const extensionPolicyPlans: any[] = [];
	for (const [name, selection] of [["omitted", undefined], ["empty", []], ["explicit", [rtkPath]]] as const) {
		for (const host of ["parent", "runner"] as const) {
			const launch = buildInProcessChildLaunch({ host, cwd: configCwd, childAgentName: "extension-policy", childIndex: 0, tools: ["read"], ...(selection === undefined ? {} : { extensions: [...selection] }), sessionEnabled: false });
			assert.equal(launch.session.ambientExtensions, name === "omitted" && host === "runner");
			assert.equal(launch.session.extensionPaths.includes(rtkPath), name === "explicit");
			extensionPolicyPlans.push({ name, host, ambientExtensions: launch.session.ambientExtensions, extensionPaths: launch.session.extensionPaths });
		}
	}
	const defaultsCwd = join(probeRoot, "extension-defaults");
	await mkdir(join(defaultsCwd, ".pi/agents"), { recursive: true });
	await writeFile(join(defaultsCwd, ".pi/agents/extension-policy-fixture.md"), "---\nname: extension-policy-fixture\ndescription: Local extension policy fixture\ntools: read\n---\nInspect only.\n");
	await writeFile(join(defaultsCwd, ".pi/settings.json"), JSON.stringify({ subagents: { defaultExtensions: [], agentOverrides: overrides } }));
	const defaults = discoverAgents(defaultsCwd, "project");
	const inherited = defaults.agents.find((agent: any) => agent.name === "extension-policy-fixture");
	assert.ok(inherited);
	assert.deepEqual(inherited.extensions, []);
	assert.deepEqual(defaults.agents.find((agent: any) => agent.name === "worker").extensions, overrides.worker.extensions);
	for (const host of ["parent", "runner"] as const) {
		const launch = buildInProcessChildLaunch({ ...inherited, host, cwd: defaultsCwd, childAgentName: inherited.name, childIndex: 0, sessionEnabled: false });
		assert.equal(launch.session.ambientExtensions, false);
		extensionPolicyPlans.push({ name: "default-empty", host, ambientExtensions: launch.session.ambientExtensions, extensionPaths: launch.session.extensionPaths });
	}
	console.log(JSON.stringify({ configurationPlans: plans.length, extensionPolicyPlans: extensionPolicyPlans.length, rolePolicyPlans: rolePolicyPlans.length }));
	return { overrides, plans, extensionPolicyPlans, rolePolicyPlans, allDiscoveredAgents: discovered.agents.map((agent: any) => ({ name: agent.name, extensions: agent.extensions })) };
}

function hash(value: unknown): string {
	return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 16);
}
function systemText(body: any): string {
	return body.instructions ?? (body.input ?? body.messages ?? []).filter((item: any) => item.role === "developer" || item.role === "system")
		.filter((item: any) => item.type !== "additional_tools").map((item: any) => JSON.stringify(item.content)).join("\n");
}
function inlineDefinitions(body: any): any[] {
	return (body.input ?? []).filter((item: any) => item.type === "additional_tools" || item.type === "tool_search_output");
}
function positionedInlineDefinitions(body: any): any[] {
	return (body.input ?? []).flatMap((item: any, index: number) => item.type === "additional_tools" || item.type === "tool_search_output" ? [[index, item]] : []);
}

function documentFixture(): Buffer {
	const stream = "BT /F1 12 Tf 20 80 Td (DOCPARSER_PROBE_MARKER) Tj ET\n";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf);
}
function describe(captured: Captured): any {
	return {
		active: captured.active,
		topLevelTools: (captured.body.tools ?? []).map((tool: any) => tool.name ?? tool.function?.name ?? tool.type),
		topLevelToolsHash: hash(captured.body.tools ?? []),
		systemHash: hash(systemText(captured.body)),
		inlineDefinitions: inlineDefinitions(captured.body),
		fffGuidelinesPresent: systemText(captured.body).includes("prefer bare identifiers"),
		alphaGuidelinePresent: systemText(captured.body).includes("PROBE_ALPHA_GUIDELINE"),
	};
}

async function runScenario(scenario: Scenario): Promise<void> {
	const cwd = join(probeRoot, scenario.name);
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(cwd, "fixture.txt"), "FFF_PROBE_MARKER\n");
	if (scenario.configRole && roleOverrides[scenario.configRole].tools.includes("document_parse")) await writeFile(join(cwd, "fixture.pdf"), documentFixture());
	if (scenario.sevenPolicy) await writeFile(join(cwd, ".pi/pi-tool-search.json"), JSON.stringify({
		version: 1,
		tools: ["grep", "find", "ls"].map((name) => ({ name, source: name === "ls" || !scenario.fff ? "builtin" : "cli", policy: scenario.name === "fff-policy-migration" ? "excluded" : "always" })),
	}));
	if (scenario.eager) await writeFile(join(cwd, ".pi/pi-tool-search.json"), JSON.stringify({ version: 1, mode: "eager", tools: [] }));
	new ProjectTrustStore(agentDir).set(cwd, true);
	process.chdir(scenario.wrongCwd ? projectRoot : cwd);
	const errors: string[] = [];
	let extensionApi: any;
	let initialCatalog: any[] = [];
	let registeredLate = false;
	const selectedTools = scenario.configRole ? roleOverrides[scenario.configRole].tools : scenario.tools ?? permittedTools;
	const runtime = {
		fanoutChild: false, depth: 1, fast: false,
		waitTool: { enabled: false }, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
		requiredTools: selectedTools.filter((name) => name !== "probe_gamma"), agent: scenario.name,
		...(scenario.supervisor ? { supervisorChannelDir: join(cwd, "supervisor"), runId: scenario.name, childIndex: 0, orchestratorSessionId: "probe-root" } : {}),
	};
	requests.set(scenario.name, []);
	pendingSnapshots.set(scenario.name, []);
	const eager = scenario.eager || scenario.replacePrompt;
	const portable = scenario.mode === "fallback" && !eager;
	sequences.set(scenario.name, [...(scenario.actions ?? (eager ? standardActions.filter((action) => !("name" in action) || action.name !== "tool_search") : standardActions))]);
	const observer = {
		name: "probe-observer",
		factory(api: any) {
			extensionApi = api;
			const mockToken = `probe.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local-mock-account" } })).toString("base64")}.unsigned`;
			api.registerProvider("compat-probe", { baseUrl, apiKey: mockToken, api: "openai-responses", models });
			if (scenario.configRole && selectedTools.includes("bash")) api.registerTool({
				name: "bash", label: "Bash fixture", description: "Record the command after actual RTK tool-call hooks; no shell execution.",
				parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
				async execute(_id: string, params: { command: string }) {
					return { content: [{ type: "text", text: params.command }], details: { command: params.command } };
				},
			});
			for (const suffix of ["alpha", "beta"]) api.registerTool({
				name: `probe_${suffix}`, label: `Probe ${suffix}`, description: `Local fixture ${suffix}`,
				parameters: { type: "object", properties: {}, additionalProperties: false },
				promptSnippet: `Fixture ${suffix}`, promptGuidelines: [`PROBE_${suffix.toUpperCase()}_GUIDELINE`],
				async execute() {
					if (scenario.lateRegistration && suffix === "alpha" && !registeredLate) {
						registeredLate = true;
						api.registerTool({ name: "probe_gamma", label: "Late fixture", description: "Late fixture", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "gamma" }], details: {} }; } });
					}
					return { content: [{ type: "text", text: `${suffix} executed` }], details: {} };
				},
			});
			api.on("session_start", () => {
				initialCatalog = api.getAllTools();
			});
			api.on("before_provider_request", (event: any, ctx: any) => {
				assert.equal(ctx.model.provider, "compat-probe");
				pendingSnapshots.get(scenario.name)!.push({ active: api.getActiveTools(), systemPrompt: ctx.getSystemPrompt(), catalog: api.getAllTools() });
			});
		},
	};
	let child: any;
	try {
		const launch = {
			cwd, storage: { kind: "dir", sessionDir: join(cwd, "sessions") }, model: `compat-probe/${scenario.name}`,
			...(scenario.inheritTools ? {} : { tools: selectedTools }),
			extensionPaths: scenario.configRole ? roleOverrides[scenario.configRole].extensions.map(resolveRoleExtension) : [...(scenario.fff ? [join(fffRoot, "src/index.ts")] : []), scenario.waitProfile ? waitProfilePath : extensionPath],
			ambientExtensions: false, hooks: [observer, ...createChildHooks(runtime)], runtime,
			noSkills: true, noContextFiles: true,
			...(scenario.replacePrompt ? { systemPrompt: "Child probe role." } : { appendSystemPrompt: "Child probe role." }),
			onExtensionError(error: any) { errors.push(`${error.event}: ${String(error.error)}`); },
		};
		child = await factory.create(launch);
		await child.prompt("Execute the scripted local compatibility probe.");
		const firstRun = requests.get(scenario.name)!.length;
		if (scenario.resume) {
			const sessionFile = child.sessionFile;
			await child.dispose();
			child = await factory.create({ ...launch, storage: { kind: "file", sessionFile } });
		}
		if (!scenario.actions) {
			sequences.set(scenario.name, [
				{ name: "probe_alpha" },
				...(scenario.sevenPolicy ? [{ name: "grep", args: { pattern: "FFF_PROBE_MARKER", path: "." } }, { name: "find", args: { pattern: "fixture" } }] : []),
				{ text: "second prompt complete" },
			]);
			await child.prompt("Reuse the loaded alpha fixture in this session.");
		}
		const captured = requests.get(scenario.name)!;
		const toolResults = child.messages.filter((message: any) => message.role === "toolResult");
		const row = {
			name: scenario.name, modelRequests: captured.length, firstRun,
			catalogNames: initialCatalog.map((tool: any) => tool.name),
			toolSources: initialCatalog.filter((tool: any) => ["grep", "find", "ls", "tool_search"].includes(tool.name)).map((tool: any) => ({ name: tool.name, source: tool.sourceInfo.source })),
			api: scenario.chatCompletions ? "openai-completions" : scenario.codex ? "openai-codex-responses" : "openai-responses",
			requests: captured.map(describe),
			toolResults: toolResults.map((message: any) => ({ name: message.toolName, isError: message.isError, addedToolNames: message.addedToolNames, details: message.details, content: message.content })),
			assistantErrors: child.messages.filter((message: any) => message.role === "assistant" && message.errorMessage).map((message: any) => message.errorMessage),
			checks: {
				betaRemainsHidden: captured.every((entry) => !entry.active.includes("probe_beta")),
				loaderAdditionsExact: toolResults.filter((message: any) => message.toolName === "tool_search" && message.addedToolNames?.length).every((message: any) => JSON.stringify(message.addedToolNames) === JSON.stringify(message.details.added)),
				topLevelToolsStable: new Set(captured.map((entry) => hash(entry.body.tools ?? []))).size === 1,
				portableDefinitions: !portable || captured.every((entry) => {
					const names = (entry.body.tools ?? []).map((tool: any) => tool.name ?? tool.function?.name);
					return inlineDefinitions(entry.body).length === 0
						&& names.length === entry.active.length && entry.active.every((name) => names.includes(name));
				}),
				portableChangesOnlyOnActivation: !portable || scenario.lateRegistration || captured.every((entry, index) => index === 0
					|| (hash(entry.active) === hash(captured[index - 1].active)) === (hash(entry.body.tools) === hash(captured[index - 1].body.tools))),
				additiveActiveSets: eager || scenario.lateRegistration || captured.every((entry, index) => index === 0
					|| captured[index - 1].active.every((name) => entry.active.includes(name))),
				systemStable: new Set(captured.map((entry) => hash(systemText(entry.body)))).size === 1,
				inlineHistoryStable: captured.every((entry, index) => index === 0 || positionedInlineDefinitions(captured[index - 1].body).every((previous, position) => hash(previous) === hash(positionedInlineDefinitions(entry.body)[position]))),
				fffGuidelinesPresent: !scenario.fff || captured.every((entry) => systemText(entry.body).includes("prefer bare identifiers")),
				deferredGuidelinesInitial: scenario.configRole || eager || scenario.tools ? true : systemText(captured[0].body).includes("After loading probe_alpha with tool_search: PROBE_ALPHA_GUIDELINE"),
				readOnlyScopeKept: scenario.name !== "readonly" || captured.every((entry) => ["bash", "edit", "write"].every((name) => !entry.active.includes(name))),
				noToolExecutionErrors: toolResults.every((message: any) => !message.isError),
				fffContentFound: !scenario.sevenPolicy || toolResults.some((message: any) => message.toolName === "grep" && JSON.stringify(message.content).includes("FFF_PROBE_MARKER")),
				configuredScope: !scenario.configRole || initialCatalog.every((tool: any) => selectedTools.includes(tool.name)),
				documentScope: documentTools.every((name) => initialCatalog.some((tool: any) => tool.name === name) === Boolean(scenario.configRole && selectedTools.includes(name))),
				documentManifest: documentTools.every((name) => {
					const description = captured[0].catalog.find((tool: any) => tool.name === "tool_search")?.description ?? "";
					return description.includes(`- ${name} —`) === Boolean(scenario.configRole && selectedTools.includes(name));
				}),
				documentParsed: !scenario.configRole || !selectedTools.includes("document_parse") || toolResults.some((message: any) => message.toolName === "document_parse" && !message.isError && JSON.stringify(message.content).includes("DOCPARSER_PROBE_MARKER")),
				documentVisibility: !scenario.configRole || !selectedTools.includes("document_parse") || (eager
					? captured.every((entry) => documentTools.every((name) => entry.active.includes(name)))
					: documentTools.every((name) => !captured[0].active.includes(name)) && captured.at(-1)!.active.includes("document_parse") && ["document_search", "document_screenshot"].every((name) => !captured.at(-1)!.active.includes(name))),
				rtkRewritten: !scenario.configRole || !selectedTools.includes("bash") || toolResults.some((message: any) => message.toolName === "bash" && message.details?.command === "rtk git status --short"),
				configuredWeb: !scenario.configRole || (eager
					? captured.every((entry) => ["web_search", "fetch_content", "get_search_content"].every((name) => entry.active.includes(name)) && !entry.active.includes("tool_search"))
					: !captured[0].active.includes("web_search") && captured.at(-1)!.active.includes("web_search")
						&& !captured.at(-1)!.active.includes("fetch_content") && !captured.at(-1)!.active.includes("get_search_content")
						&& JSON.stringify(portable ? captured.at(-1)!.body.tools : inlineDefinitions(captured.at(-1)!.body)).includes('"name":"web_search"')),
				waitPolicy: !selectedTools.includes("bg_wait")
					? captured.every((entry) => !entry.active.includes("bg_wait"))
					: scenario.waitProfile ? captured.every((entry) => entry.active.includes("bg_wait"))
						: !captured[0].active.includes("bg_wait") && (scenario.name.startsWith("bg-wait-")
							? captured.at(-1)!.active.includes("bg_wait") : captured.every((entry) => !entry.active.includes("bg_wait"))),
				supervisorAlwaysActive: !scenario.supervisor || captured.every((entry) => entry.active.includes("contact_supervisor")),
			},
			errors, finalActive: extensionApi.getActiveTools(), sessionFile: child.sessionFile,
		};
		results.push(row);
		await writeFile(join(cwd, "requests.json"), JSON.stringify(captured, null, 2));
		console.log(JSON.stringify({ name: row.name, requests: row.modelRequests, initialActive: row.requests[0]?.active, checks: row.checks, errors: [...errors, ...row.assistantErrors] }));
	} catch (error) {
		results.push({ name: scenario.name, fatal: String(error), errors });
		console.error(`${scenario.name}: ${String(error)}`);
	} finally {
		if (child) await child.dispose();
	}
}

function assertResults(): number {
	let assertions = 0;
	const verify = (condition: unknown, message: string) => { assertions++; assert.ok(condition, message); };
	for (const scenario of cases) {
		const result = results.find((value) => value.name === scenario.name);
		verify(result && !result.fatal, `${scenario.name}: completed`);
		verify(result.errors.length === 0 && result.assistantErrors.length === 0, `${scenario.name}: runtime errors`);
		const eager = scenario.eager || scenario.replacePrompt;
		const portable = scenario.mode === "fallback" && !eager;
		verify(eager && !scenario.configRole ? !result.checks.betaRemainsHidden : result.checks.betaRemainsHidden, `${scenario.name}: beta visibility does not match mode`);
		verify(result.checks.loaderAdditionsExact, `${scenario.name}: incidental activation polluted loader result`);
		verify(result.checks.deferredGuidelinesInitial, `${scenario.name}: missing initial conditional guidelines`);
		verify(result.checks.noToolExecutionErrors, `${scenario.name}: tool execution errors`);
		verify(result.checks.documentScope, `${scenario.name}: document provider scope mismatch`);
		verify(result.checks.documentManifest, `${scenario.name}: document manifest contains unavailable tools or omits available ones`);
		verify(result.checks.portableDefinitions, `${scenario.name}: portable wire tool list differs from active tools`);
		verify(result.checks.portableChangesOnlyOnActivation, `${scenario.name}: portable definitions changed without activation`);
		verify(result.checks.additiveActiveSets, `${scenario.name}: loaded tools were removed`);
		verify(result.checks.waitPolicy, `${scenario.name}: bg_wait policy mismatch`);
		if (scenario.mode !== "fallback") verify(result.checks.inlineHistoryStable, `${scenario.name}: historical inline definitions moved or changed`);
		if (!scenario.lateRegistration) {
			if (!portable) verify(result.checks.topLevelToolsStable, `${scenario.name}: prefix tools changed`);
			verify(result.checks.systemStable, `${scenario.name}: tool-metadata prefix changed`);
		}
		if (scenario.sevenPolicy) {
			verify(result.checks.fffContentFound, `${scenario.name}: FFF grep failed`);
			verify(result.checks.fffGuidelinesPresent === !scenario.replacePrompt, `${scenario.name}: unexpected FFF guideline visibility`);
		}
		if (scenario.configRole) {
			verify(result.checks.configuredScope, `${scenario.name}: role allowlist widened`);
			verify(result.checks.configuredWeb, `${scenario.name}: real Web tools not exposed according to mode`);
			if (roleOverrides[scenario.configRole].tools.includes("bash")) verify(result.checks.rtkRewritten, `${scenario.name}: RTK did not rewrite the bash command`);
			if (roleOverrides[scenario.configRole].tools.includes("document_parse")) {
				verify(result.checks.documentParsed, `${scenario.name}: local PDF parsing failed`);
				verify(result.checks.documentVisibility, `${scenario.name}: document schemas not exposed according to mode`);
			}
		}
		if (scenario.fff) verify(result.checks.fffGuidelinesPresent === !scenario.replacePrompt, `${scenario.name}: FFF metadata missing`);
		if (scenario.name === "readonly") verify(result.checks.readOnlyScopeKept, "read-only role widened");
		if (scenario.supervisor) verify(result.checks.supervisorAlwaysActive, "supervisor control tool deferred");
	}
	const missing = results.find((value) => value.name === "allowlist-missing-target");
	verify(missing.toolResults.some((value: any) => JSON.stringify(value.content).includes("Unknown deferred tool: probe_alpha")), "missing target bypassed allowlist");
	const noLoader = results.find((value) => value.name === "allowlist-missing-loader");
	verify(!noLoader.catalogNames.includes("tool_search"), "loader bypassed allowlist");
	const noDocuments = results.find((value) => value.name === "docparser-unloaded");
	verify(noDocuments.toolResults.some((value: any) => value.name === "tool_search" && value.details.added.length === 0 && documentTools.every((name) => value.details.unknown.includes(name))), "missing document provider was not rejected by loader");
	for (const name of ["concurrent-idle", "concurrent-portable-idle", "concurrent-wait-idle"]) {
		const cold = results.find((value) => value.name === name);
		verify(cold.requests.every((value: any) => !value.active.includes("probe_alpha")), `${name}: loaded state leaked across concurrent children`);
	}
	return assertions;
}

try {
	console.log(`Probe artifacts: ${probeRoot}`);
	for (const scenario of cases.filter((value) => !value.name.startsWith("concurrent-"))) await runScenario(scenario);
	await Promise.all(cases.filter((value) => value.name.startsWith("concurrent-")).map(runScenario));
	const configuration = await inspectConfigurationPlans();
	let assertionError: unknown;
	let verifiedAssertions: number | undefined;
	try { verifiedAssertions = assertResults(); } catch (error) { assertionError = error; }
	const versions: Record<string, string> = {};
	for (const [name, root] of [["pi", piRoot], ["subagents", subagentsRoot], ["fff", fffRoot], ["web", webRoot], ["docparser", docparserRoot]]) {
		versions[name] = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
	}
	const sourceFiles = await Promise.all((await readdir(dirname(extensionPath), { recursive: true })).filter((name) => name.endsWith(".ts")).sort()
		.map(async (name) => [name, createHash("sha256").update(await readFile(join(dirname(extensionPath), name))).digest("hex")]));
	const sourceSha256 = hash(sourceFiles);
	await writeFile(join(probeRoot, "report.json"), JSON.stringify({ versions, extensionPath, sourceSha256, sourceFiles, results, configuration, verifiedAssertions, transportErrors, assertionError: String(assertionError ?? "") }, null, 2));
	if (verifiedAssertions) console.log(`Request assertions passed: ${verifiedAssertions}`);
	console.log(`Report: ${join(probeRoot, "report.json")}`);
	if (assertionError) throw assertionError;
	if (transportErrors.length || results.some((result) => result.fatal || result.errors?.length || result.assistantErrors?.length)) process.exitCode = 1;
} finally {
	await factory.dispose();
	server.closeAllConnections();
	await new Promise<void>((done) => server.close(() => done()));
	process.chdir(projectRoot);
}

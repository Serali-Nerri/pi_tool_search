/** Inspect the resolved model, including dynamic model catalogues and custom providers. */
export function supportsIncrementalTools(model: { api: string; compat?: unknown } | undefined): boolean {
	if (!model) return false;
	const compat = model.compat as {
		supportsAdditionalTools?: boolean;
		supportsToolSearch?: boolean;
		supportsToolReferences?: boolean;
	} | undefined;
	if (model.api === "anthropic-messages") return compat?.supportsToolReferences === true;
	return ["openai-responses", "openai-codex-responses"].includes(model.api)
		&& (compat?.supportsAdditionalTools === true || compat?.supportsToolSearch === true);
}

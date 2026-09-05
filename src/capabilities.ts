/** Inspect the resolved model, including dynamic model catalogues and custom providers. */
export function supportsIncrementalTools(model: { api: string; compat?: unknown } | undefined): boolean {
	if (!model || !["openai-responses", "openai-codex-responses"].includes(model.api)) return false;
	const compat = model.compat as { supportsAdditionalTools?: boolean; supportsToolSearch?: boolean } | undefined;
	return compat?.supportsAdditionalTools === true || compat?.supportsToolSearch === true;
}

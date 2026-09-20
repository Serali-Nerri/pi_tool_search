/** Declared transport capability only; removals/redefinitions can still force a checkpoint. */
export function supportsIncrementalTools(model: { api: string; compat?: unknown } | undefined): boolean {
	if (!model || !model.compat || typeof model.compat !== "object") return false;
	const compat = model.compat as {
		supportsMidConvoSystemMessages?: boolean;
		supportsAdditionalTools?: boolean;
		supportsToolSearch?: boolean;
		supportsMidConvoToolChanges?: boolean;
		supportsMidConvoToolAdditions?: boolean;
	};
	if (compat.supportsMidConvoSystemMessages !== true) return false;
	if (model.api === "anthropic-messages") return compat.supportsMidConvoToolChanges === true;
	if (model.api === "openai-completions") return compat.supportsMidConvoToolAdditions === true;
	return ["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(model.api)
		&& (compat.supportsAdditionalTools === true || compat.supportsToolSearch === true);
}

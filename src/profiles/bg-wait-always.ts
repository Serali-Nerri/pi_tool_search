import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolSearch } from "../lifecycle.ts";

/** Select this entry instead of index.ts only for roles requiring an always-visible wait tool. */
export default function toolSearchWithBackgroundWait(pi: ExtensionAPI): void {
	registerToolSearch(pi, process.cwd(), fileURLToPath(import.meta.url), { alwaysTools: ["bg_wait"] });
}

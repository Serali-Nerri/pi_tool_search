import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolSearch } from "./lifecycle.ts";

export {
	loadTrustedToolSearchPolicies,
	registerToolSearch,
	saveToolSearchConfiguration,
} from "./lifecycle.ts";

export default function piToolSearch(pi: ExtensionAPI): void {
	registerToolSearch(pi, process.cwd(), resolve(fileURLToPath(import.meta.url)));
}

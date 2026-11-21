import { combine, type Derived, operatorValue } from "../config/registry";
import { ghidraHostSupported } from "../ghidra/platform";
import { cfgIdaInstall } from "../ida/install";
import type { DisasmBackendId } from "./backend";
import { cfgDisassembler } from "./settings";

/** Backend serving explicit read analysis and eval's dsm namespace; undefined leaves metadata-only reads. */
export const cfgDisasmBackend: Derived<DisasmBackendId | undefined> = combine(
	{ choice: cfgDisassembler, authority: operatorValue(cfgDisassembler), ida: operatorValue(cfgIdaInstall) },
	({ choice, authority, ida }) =>
		choice === "none" || choice !== authority
			? undefined
			: choice === "ida"
				? ida
					? "ida"
					: undefined
				: choice === "ghidra"
					? ghidraHostSupported()
						? "ghidra"
						: undefined
					: ida
						? "ida"
						: ghidraHostSupported()
							? "ghidra"
							: undefined,
);

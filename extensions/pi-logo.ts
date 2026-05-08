/**
 * Pi Logo Header Extension
 *
 * Replaces the default header with the pi.dev block logo.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";

function getPiLogo(theme: any): string[] {
	const B = "████";
	const S = "    "; // same width spacer
	const c = (text: string) => theme.fg("accent", text);

	// Grid from the SVG:
	//   Col 0  Col 1  Col 2  Col 3
	// Row 0:  ████   ████   ████
	// Row 1:  ████          ████
	// Row 2:  ████   ████          ████
	// Row 3:  ████                 ████

	// Double each row for squarer proportions
	const row0 = `  ${c(B + B + B)}`;
	const row1 = `  ${c(B)}${S}${c(B)}`;
	const row2 = `  ${c(B + B)}${S}${c(B)}`;
	const row3 = `  ${c(B)}${S}${S}${c(B)}`;

	return [
		"",
		row0,
		row0,
		row1,
		row1,
		row2,
		row2,
		row3,
		row3,
		theme.fg("dim", `  pi v${VERSION}`),
		"",
	];
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setHeader((_tui, theme) => ({
				render(_width: number): string[] {
					return getPiLogo(theme);
				},
				invalidate() {},
			}));
		}
	});

	pi.registerCommand("default-header", {
		description: "Restore the default pi header",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Default header restored", "info");
		},
	});
}

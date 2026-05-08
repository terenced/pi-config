/**
 * Colormode Theme Extension
 *
 * Watches ~/.config/colormode and sets the pi theme to match.
 * Write "dark" or "light" to the file, or any valid theme name.
 *
 * Maps:
 *   "dark"  -> catppuccin-mocha
 *   "light" -> catppuccin-latte
 *   anything else -> used as-is (e.g. "catppuccin-mocha")
 *
 * Usage:
 *   echo "dark" > ~/.config/colormode
 *   echo "light" > ~/.config/colormode
 *
 * Auto-discovered from ~/.pi/agent/extensions/
 * Or test with: pi -e ~/.pi/agent/extensions/colormode-theme.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COLORMODE_FILE = path.join(
	process.env.HOME ?? "~",
	".config",
	"colormode",
);

const THEME_MAP: Record<string, string> = {
	dark: "catppuccin-mocha",
	light: "catppuccin-latte",
};

function readColormode(): string | null {
	try {
		const content = fs.readFileSync(COLORMODE_FILE, "utf-8").trim();
		if (!content) return null;
		return THEME_MAP[content] ?? content;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	let watcher: fs.FSWatcher | null = null;
	let currentTheme: string | null = null;

	pi.on("session_start", async (_event, ctx) => {
		// Apply theme from file on startup
		const theme = readColormode();
		if (theme) {
			currentTheme = theme;
			const result = ctx.ui.setTheme(theme);
			if (!result.success) {
				ctx.ui.notify(`Unknown theme "${theme}" in colormode file`, "error");
			}
		}

		// Watch for changes
		try {
			watcher = fs.watch(COLORMODE_FILE, () => {
				const newTheme = readColormode();
				if (newTheme && newTheme !== currentTheme) {
					currentTheme = newTheme;
					const result = ctx.ui.setTheme(newTheme);
					if (!result.success) {
						ctx.ui.notify(
							`Unknown theme "${newTheme}" in colormode file`,
							"error",
						);
					}
				}
			});
		} catch {
			ctx.ui.notify(
				`Could not watch ${COLORMODE_FILE} — create the file first`,
				"warn",
			);
		}
	});

	pi.on("session_shutdown", () => {
		if (watcher) {
			watcher.close();
			watcher = null;
		}
	});
}

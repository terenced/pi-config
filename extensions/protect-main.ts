/**
 * Protect main: block agent bash commands that commit to or push to `main`.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROTECTED = ["main", "master"];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd: string = event.input.command ?? "";

    // Only inspect git invocations
    if (!/\bgit\b/.test(cmd)) return;

    const onProtected = PROTECTED.some((b) =>
      new RegExp(`\\b${b}\\b`).test(cmd),
    );

    // Block: pushing to a protected branch
    //   git push ... origin main      | git push origin HEAD:main
    //   git push -u origin main       | git push --force origin main
    const isPushToProtected =
      /\bgit\s+push\b/.test(cmd) &&
      PROTECTED.some(
        (b) =>
          new RegExp(`\\borigin\\s+(?:HEAD:)?${b}\\b`).test(cmd) ||
          new RegExp(`\\b${b}\\b`).test(cmd.replace(/\borigin\b/, "")),
      );

    // Block: committing while ON a protected branch (we can't tell from the
    // command alone, so check current branch via git)
    let isCommitOnProtected = false;
    if (/\bgit\s+commit\b/.test(cmd)) {
      try {
        const { execSync } = await import("node:child_process");
        const branch = execSync("git rev-parse --abbrev-ref HEAD", {
          encoding: "utf8",
        }).trim();
        isCommitOnProtected = PROTECTED.includes(branch);
      } catch {
        // not a git repo or git missing — let it through
      }
    }

    if (!isPushToProtected && !isCommitOnProtected) return;

    const reason = isPushToProtected
      ? `Refusing to push directly to a protected branch. Use a feature branch + PR.`
      : `Refusing to commit while on protected branch. Switch to a feature branch first.`;

    if (!ctx.hasUI) {
      return { block: true, reason };
    }

    const choice = await ctx.ui.select(
      `🛑 Protected branch guard\n\n  ${cmd}\n\n${reason}\n\nAllow anyway?`,
      ["No (block)", "Yes (allow)"],
    );
    if (choice !== "Yes (allow)") {
      return {
        block: true,
        reason: "Blocked by user (protect-main extension)",
      };
    }
  });
}

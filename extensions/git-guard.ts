import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;

    // Block git commit --amend entirely
    if (/\bgit\s+commit\b.*--amend\b/.test(command)) {
      return { block: true, reason: "git commit --amend is not allowed." };
    }

    // Require confirmation for git push
    if (/\bgit\s+push\b/.test(command)) {
      const ok = await ctx.ui.confirm(
        "Git Push",
        `Allow this command?\n\n${command}`,
      );
      if (!ok) {
        return { block: true, reason: "git push was rejected by user." };
      }
    }
  });
}

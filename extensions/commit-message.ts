import { complete } from "@mariozechner/pi-ai";
import type { UserMessage } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	BorderedLoader,
} from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

type GitResult = {
	stdout: string;
	stderr: string;
	code: number;
};

type CommitMessageConfig = {
	maxDiffLength: number;
	verbosity: VerbosityLevel;
};

type VerbosityLevel = "short" | "simple" | "normal" | "verbose";

const DEFAULT_MAX_DIFF_LENGTH = 8000;
const MIN_DIFF_LENGTH = 1000;
const MAX_DIFF_LENGTH = 50000;

const DEFAULT_CONFIG: CommitMessageConfig = {
	maxDiffLength: DEFAULT_MAX_DIFF_LENGTH,
	verbosity: "normal",
};

const CONFIG_FILE_NAME = "commit-message-settings.json";

const CONVENTIONAL_SUBJECT_RE = /^\w+(\(\w+\))?!?:/;

function buildSystemPrompt(verbosity: VerbosityLevel): string {
	const base = `You are a git commit message generator. Given a git diff, produce a commit message following the Conventional Commits 1.0.0 specification.

Types: feat, fix, docs, style, refactor, perf, test, chore, ci, build
Format: <type>(<scope>): <description>`;

	switch (verbosity) {
		case "short":
			return `${base}

Output ONLY the subject line. Imperative mood, lowercase, no period, max 50 chars.`;

		case "simple":
			return `${base}

Rules:
- Scope is optional. If provided, use lowercase.
- Description: imperative mood, lowercase, no period at end, max 72 chars total.
- Output ONLY the subject line. No explanation, no markdown fences.`;

		case "normal":
			return `${base}

Rules:
- Scope is optional. If provided, use lowercase, short name of the affected module.
- Description: imperative mood, lowercase, no period at end, max 72 chars total for subject line.
- Add a footer "BREAKING CHANGE: <description>" only if the change breaks an existing API.
- If multiple logical changes exist, pick the most significant for the subject line.
- Output ONLY the commit message. No explanation, no markdown fences.`;

		case "verbose":
			return `${base}

Rules:
- Scope is optional. If provided, use lowercase, short name of the affected module.
- Description: imperative mood, lowercase, no period at end, max 72 chars total for subject line.
- Add a footer "BREAKING CHANGE: <description>" only if the change breaks an existing API.
- If multiple logical changes exist, pick the most significant for the subject line.
- Include a concise body explaining what changed and why (if non-trivial).
- Output ONLY the commit message. No explanation, no markdown fences.`;
	}
}

const STAGE_ALL_OPTION = "Stage all changes (git add -A) and continue";
const CANCEL_OPTION = "Cancel";

const COMMIT_OPTION = "Commit with this message";
const EDIT_OPTION = "Edit message";
const REGENERATE_OPTION = "Regenerate";

const SEND_FULL_DIFF_OPTION = "Send full diff";
const USE_TRUNCATED_DIFF_OPTION = "Use truncated diff";

function getConfigDir(): string {
	return join(homedir(), ".pi", "agent", "data", "commit-message");
}

function getConfigPath(): string {
	return join(getConfigDir(), CONFIG_FILE_NAME);
}

async function loadConfig(): Promise<CommitMessageConfig> {
	try {
		const configPath = getConfigPath();
		const content = await readFile(configPath, "utf8");
		const parsed = JSON.parse(content) as Partial<CommitMessageConfig>;

		return {
			maxDiffLength: clampDiffLength(parsed.maxDiffLength ?? DEFAULT_MAX_DIFF_LENGTH),
			verbosity: (parsed.verbosity as VerbosityLevel) ?? DEFAULT_CONFIG.verbosity,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

async function saveConfig(config: CommitMessageConfig): Promise<void> {
	const configDir = getConfigDir();
	const configPath = getConfigPath();

	await mkdir(configDir, { recursive: true });
	await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

function clampDiffLength(value: number): number {
	return Math.max(MIN_DIFF_LENGTH, Math.min(MAX_DIFF_LENGTH, value));
}

function truncateDiff(diff: string, maxLength: number): string {
	if (diff.length <= maxLength) {
		return diff;
	}
	return `${diff.slice(0, maxLength)}\n[diff truncated for length]`;
}

function detectScope(diff: string): string {
	const files = new Set<string>();
	const re = /^diff --git a\/(\S+)/gm;
	let match: RegExpExecArray | null;

	while ((match = re.exec(diff)) !== null) {
		files.add(match[1]);
	}

	const changedFiles = [...files];
	if (changedFiles.length === 0) {
		return "";
	}

	if (changedFiles.length === 1) {
		const file = changedFiles[0].split("/").pop() ?? changedFiles[0];
		const dotIndex = file.lastIndexOf(".");
		return dotIndex > 0 ? file.slice(0, dotIndex) : file;
	}

	const topLevelDirs = changedFiles
		.map((f) => f.split("/")[0])
		.filter((d) => d.length > 0);
	const uniqueDirs = [...new Set(topLevelDirs)];

	return uniqueDirs.length === 1 ? uniqueDirs[0] : "";
}

function firstLine(message: string): string {
	return (message.split(/\r?\n/)[0] ?? "").trim();
}

function looksLikeConventionalCommitSubject(input: string): boolean {
	return CONVENTIONAL_SUBJECT_RE.test(input.trim());
}

async function git(pi: ExtensionAPI, args: string[]): Promise<GitResult> {
	const result = await pi.exec("git", args);
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		code: result.code ?? 1,
	};
}

async function generateCommitMessage(
	ctx: ExtensionCommandContext,
	diffForPrompt: string,
	scopeHint: string,
	userArgs: string,
	extraContext: string[],
	hasBinaryEntries: boolean,
	verbosity: VerbosityLevel,
): Promise<string | undefined> {
	if (!ctx.model) {
		ctx.ui.notify("No model selected for commit message generation.", "error");
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) {
		ctx.ui.notify(auth.error, "error");
		return undefined;
	}
	if (!auth.apiKey) {
		ctx.ui.notify(`No API key for ${ctx.model.provider}/${ctx.model.id}.`, "error");
		return undefined;
	}

	const model = ctx.model;

	const extraContextText =
		extraContext.length > 0
			? extraContext.map((line) => `- ${line}`).join("\n")
			: "none";
	const binaryLine = hasBinaryEntries
		? "The diff may contain binary file entries — ignore them."
		: "none";

	const userContext = userArgs
		? `\n\nIMPORTANT USER CONTEXT:
"${userArgs}"
You MUST follow this instruction exactly when generating the commit message.`
		: "";

	const userPrompt = `Generate a git commit message for the following diff.${userContext}

Diff:
${diffForPrompt}

Detected scope hint: ${scopeHint || "none"}
Additional repo context:
${extraContextText}
Binary file note: ${binaryLine}`;

	const messages: UserMessage[] = [
		{
			role: "user",
			content: [{ type: "text", text: userPrompt }],
			timestamp: Date.now(),
		} satisfies UserMessage,
	];

	const generatedMessage = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(
			tui,
			theme,
			`Generating commit message using ${model.id}...`,
		);

		loader.onAbort = () => done(null);

		const doGenerate = async () => {
			const response = await complete(
				model,
				{ systemPrompt: buildSystemPrompt(verbosity), messages },
				{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
			);

			if (response.stopReason === "aborted") {
				done(null);
				return;
			}

			const text = response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();

			done(text || null);
		};

		doGenerate().catch(() => done(null));

		return loader;
	});

	if (!generatedMessage) {
		ctx.ui.notify("Commit message generation failed or was cancelled.", "warning");
		return undefined;
	}

	return generatedMessage;
}

export default function commitMessageExtension(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Generate a Conventional Commits message from staged changes and commit",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			const config = await loadConfig();

			let stagedStat = await git(pi, ["diff", "--staged", "--stat"]);
			if (stagedStat.code !== 0) {
				ctx.ui.notify("Not a git repository.", "error");
				return;
			}

			if (stagedStat.stdout.trim() === "") {
				const choice = await ctx.ui.select(
					"Nothing is staged. What would you like to do?",
					[STAGE_ALL_OPTION, CANCEL_OPTION],
				);

				if (choice !== STAGE_ALL_OPTION) {
					return;
				}

				const addAllResult = await git(pi, ["add", "-A"]);
				if (addAllResult.code !== 0) {
					const addErr = addAllResult.stderr.trim() || addAllResult.stdout.trim() || "unknown error";
					ctx.ui.notify(`Failed to stage changes: ${addErr}`, "error");
					return;
				}

				stagedStat = await git(pi, ["diff", "--staged", "--stat"]);
				if (stagedStat.stdout.trim() === "") {
					ctx.ui.notify("No changes to commit.", "info");
					return;
				}
			}

			const diffResult = await git(pi, ["diff", "--staged"]);
			if (diffResult.code !== 0) {
				const diffErr = diffResult.stderr.trim() || diffResult.stdout.trim() || "unknown error";
				ctx.ui.notify(`Failed to read staged diff: ${diffErr}`, "error");
				return;
			}
			const rawDiff = diffResult.stdout;

			if (rawDiff.trim() === "") {
				ctx.ui.notify(
					"Staged files found but diff is empty. Try committing after making changes.",
					"warning",
				);
				return;
			}

			let diffForPrompt = rawDiff;

			if (rawDiff.length > config.maxDiffLength) {
				const choice = await ctx.ui.select(
					`Diff is large (${rawDiff.length.toLocaleString()} chars). Max set to ${config.maxDiffLength.toLocaleString()} chars.`,
					[SEND_FULL_DIFF_OPTION, USE_TRUNCATED_DIFF_OPTION],
				);

				if (choice === SEND_FULL_DIFF_OPTION) {
					diffForPrompt = rawDiff;
					ctx.ui.notify("Sending full diff to the model.", "info");
				} else {
					diffForPrompt = truncateDiff(rawDiff, config.maxDiffLength);
				}
			}

			const scopeHint = detectScope(rawDiff);
			const userArgs = args.trim();
			const hasBinaryEntries = /Binary files .* differ/.test(rawDiff);

			const isMergeCommit = (await git(pi, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]))
				.code === 0;
			const isInitialCommit = (await git(pi, ["log", "--oneline", "-1"]))
				.code !== 0;

			const extraContext: string[] = [];
			if (isInitialCommit) {
				extraContext.push("Note: this is the initial commit for the repository.");
			}
			if (isMergeCommit) {
				extraContext.push("Note: this is a merge commit resolution.");
			}

			let currentMessage: string | undefined;
			if (looksLikeConventionalCommitSubject(userArgs)) {
				currentMessage = userArgs;
			} else {
				currentMessage = await generateCommitMessage(
					ctx,
					diffForPrompt,
					scopeHint,
					userArgs,
					extraContext,
					hasBinaryEntries,
					config.verbosity,
				);
			}

			if (!currentMessage) {
				return;
			}

			let regenerateCount = 0;

			while (true) {
				const tip =
					regenerateCount >= 3 ? "\n\nTip: use 'Edit message' to adjust directly." : "";

				const choice = await ctx.ui.select(
					`Generated commit message:\n\n  ${currentMessage}\n\nWhat would you like to do?${tip}`,
					[COMMIT_OPTION, EDIT_OPTION, REGENERATE_OPTION, CANCEL_OPTION],
				);

				if (choice === COMMIT_OPTION) {
					break;
				}

				if (choice === EDIT_OPTION) {
					const edited = await ctx.ui.editor("Edit commit message:", currentMessage);
					if (edited?.trim()) {
						currentMessage = edited.trim();
					}
					continue;
				}

				if (choice === REGENERATE_OPTION) {
					regenerateCount += 1;
					const regenerated = await generateCommitMessage(
						ctx,
						diffForPrompt,
						scopeHint,
						userArgs,
						extraContext,
						hasBinaryEntries,
							config.verbosity,
					);
					if (regenerated) {
						currentMessage = regenerated;
					}
					continue;
				}

				return;
			}

			const commitResult = await git(pi, ["commit", "-m", currentMessage]);
			if (commitResult.code === 0) {
				ctx.ui.notify(`Committed: ${firstLine(currentMessage)}`, "info");
				return;
			}

			const errorText = commitResult.stderr.trim() || commitResult.stdout.trim() || "unknown error";
			ctx.ui.notify(`Commit failed: ${errorText}`, "error");
		},
	});

	pi.registerCommand("commit:config", {
		description: "Configure /commit settings",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			const config = await loadConfig();

			const settingChoice = await ctx.ui.select(
				"Select setting to configure:",
				[
					`Max diff length (${config.maxDiffLength.toLocaleString()} chars)`,
					`Verbosity (${config.verbosity})`,
					"Cancel",
				],
			);

			if (!settingChoice || settingChoice === "Cancel") {
				return;
			}

			if (settingChoice.startsWith("Max diff length")) {
				const choice = await ctx.ui.select(
					`Max diff length: ${config.maxDiffLength.toLocaleString()} chars`,
					[
						`Set to 4000 chars`,
						`Set to 8000 chars`,
						`Set to 16000 chars`,
						`Set to 32000 chars`,
						`Set to 50000 chars`,
						`Custom...`,
						"Cancel",
					],
				);

				if (!choice || choice === "Cancel") {
					return;
				}

				const lengthMap: Record<string, number> = {
					"Set to 4000 chars": 4000,
					"Set to 8000 chars": 8000,
					"Set to 16000 chars": 16000,
					"Set to 32000 chars": 32000,
					"Set to 50000 chars": 50000,
				};

				let newLength: number | undefined;

				if (choice === "Custom...") {
					const input = await ctx.ui.input(
						`Custom max diff length (${MIN_DIFF_LENGTH}-${MAX_DIFF_LENGTH}):`,
						config.maxDiffLength.toString(),
					);

					if (!input) {
						return;
					}

					const parsed = parseInt(input.trim(), 10);
					if (isNaN(parsed)) {
						ctx.ui.notify("Invalid number. Keeping current value.", "warning");
						return;
					}

					newLength = clampDiffLength(parsed);

					if (newLength !== parsed) {
						ctx.ui.notify(
							`Value clamped to ${newLength.toLocaleString()} chars (min: ${MIN_DIFF_LENGTH}, max: ${MAX_DIFF_LENGTH}).`,
							"info",
						);
					}
				} else {
					newLength = lengthMap[choice];
				}

				if (newLength !== undefined) {
					config.maxDiffLength = newLength;
					await saveConfig(config);
					ctx.ui.notify(`Max diff length set to ${newLength.toLocaleString()} chars.`, "info");
				}
			}

			if (settingChoice.startsWith("Verbosity")) {
				const verbosityLabels: Record<VerbosityLevel, string> = {
					short: "Short",
					simple: "Simple",
					normal: "Normal",
					verbose: "Verbose",
				};

				const verbosityChoice = await ctx.ui.select(
					`Verbosity: ${verbosityLabels[config.verbosity]}`,
					[
						"Short",
						"Simple",
						"Normal",
						"Verbose",
						"Cancel",
					],
				);

				if (!verbosityChoice || verbosityChoice === "Cancel") {
					return;
				}

				const verbosityMap: Record<string, VerbosityLevel> = {
					"Short": "short",
					"Simple": "simple",
					"Normal": "normal",
					"Verbose": "verbose",
				};

				const newVerbosity = verbosityMap[verbosityChoice];
				if (newVerbosity) {
					config.verbosity = newVerbosity;
					await saveConfig(config);
					ctx.ui.notify(`Verbosity set to ${verbosityLabels[newVerbosity]}.`, "info");
				}
			}
		},
	});
}
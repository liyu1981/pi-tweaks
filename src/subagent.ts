/**
 * Subagent runner.
 *
 * Spawns a separate `pi` process in JSON event-stream mode so a task runs in an
 * isolated context window with full tool access. The child is invoked exactly
 * like pi's own `subagent` example:
 *
 *   pi --mode json -p --no-session --model <provider>/<model> "<task>"
 *
 * `modeArg` may carry an OpenRouter provider-lock suffix
 * (`<baseId>:<providerSlug>`); the child's `pt-openrouter-lock-provider`
 * extension strips it again and turns it into OpenRouter's `provider.order`,
 * mirroring how `remember-model` persists a variant id into pi's settings.
 *
 * The runner never rejects for a failed/aborted child: it resolves with a
 * {@link SubagentRunResult} so the caller can still persist a partial transcript.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Usage } from "@earendil-works/pi-ai";

// ─── Types ──────────────────────────────────────────────────────────────

export type SubagentStatus = "running" | "ok" | "error" | "aborted";

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface SubagentRunResult {
	profile: string;
	provider: string;
	/** Exact string passed to `--model` (may carry `:<lockProvider>`). */
	modelArg: string;
	/** Base model id without the lock suffix. */
	baseModel: string;
	/** OpenRouter upstream provider lock, when one applied. */
	lockProvider?: string;
	task: string;
	status: SubagentStatus;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
	messages: Message[];
	displayItems: DisplayItem[];
	finalOutput: string;
	usage: SubagentUsage;
	durationMs: number;
}

export interface RunSubagentOptions {
	cwd: string;
	profile: string;
	provider: string;
	modelArg: string;
	baseModel: string;
	lockProvider?: string;
	task: string;
	/**
	 * Mirror the parent's project-trust decision into the child. Pi runs
	 * non-interactively without a trust prompt, so project-local settings,
	 * extensions, skills and packages are ignored unless `--approve` is passed.
	 */
	trustProject?: boolean;
	/** Extra system-prompt text appended to the child (working dir, project rules). */
	systemPrompt?: string;
	signal?: AbortSignal;
	onUpdate?: (result: SubagentRunResult) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function emptyUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: SubagentUsage, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

/** Render one tool call the way pi's built-in tool rows do. */
export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			let text = themeFg("accent", shortenPath(rawPath));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") items.push({ type: "text", text: part.text });
			else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
		}
	}
	return items;
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * Resolve how to re-invoke pi from inside a running pi process.
 *
 * When `process.argv[1]` is a real script on disk, run it with the current
 * runtime (covers both `pi` shims and direct `node <script>` invocations). In a
 * bundled runtime (`/$bunfs/root/...`) fall back to the `pi` executable, and if
 * the current runtime is already a generic `node`/`bun`, use `pi` from PATH.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

// ─── Runner ─────────────────────────────────────────────────────────────

function accumulateUsage(target: SubagentUsage, usage: Usage): void {
	target.input += usage.input || 0;
	target.output += usage.output || 0;
	target.cacheRead += usage.cacheRead || 0;
	target.cacheWrite += usage.cacheWrite || 0;
	target.cost += usage.cost?.total || 0;
	target.contextTokens = usage.totalTokens || target.contextTokens;
}

export async function runSubagent(options: RunSubagentOptions): Promise<SubagentRunResult> {
	const startedAt = Date.now();
	const result: SubagentRunResult = {
		profile: options.profile,
		provider: options.provider,
		modelArg: options.modelArg,
		baseModel: options.baseModel,
		lockProvider: options.lockProvider,
		task: options.task,
		status: "running",
		stderr: "",
		messages: [],
		displayItems: [],
		finalOutput: "",
		usage: emptyUsage(),
		durationMs: 0,
	};

	const emit = () => {
		result.displayItems = getDisplayItems(result.messages);
		result.finalOutput = getFinalOutput(result.messages);
		result.durationMs = Date.now() - startedAt;
		options.onUpdate?.(result);
	};

	const args = ["--mode", "json", "-p", "--no-session"];
	if (options.trustProject !== undefined) {
		args.push(options.trustProject ? "--approve" : "--no-approve");
	}
	if (options.systemPrompt?.trim()) {
		args.push("--append-system-prompt", options.systemPrompt);
	}
	args.push("--model", options.modelArg, options.task);
	const invocation = getPiInvocation(args);

	let wasAborted = false;

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			// Tell sibling pi-tweaks extensions (notably remember-model) that this
			// child was launched with an explicit model and must not restore or
			// persist a different one.
			env: { ...process.env, PT_SUBAGENT_CHILD: "1" },
		});

		let buffer = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_end" && event.message) {
				const msg = event.message as Message;
				result.messages.push(msg);
				if (msg.role === "assistant") {
					result.usage.turns++;
					if (msg.usage) accumulateUsage(result.usage, msg.usage);
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
				}
				emit();
			} else if (event.type === "tool_result_end" && event.message) {
				result.messages.push(event.message as Message);
				emit();
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			result.stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});

		proc.on("error", (error) => {
			result.errorMessage = result.errorMessage ?? error.message;
			resolve(1);
		});

		if (options.signal) {
			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
				}, 5000);
			};
			if (options.signal.aborted) killProc();
			else options.signal.addEventListener("abort", killProc, { once: true });
		}
	});

	if (wasAborted) {
		result.status = "aborted";
	} else if (exitCode !== 0 || result.stopReason === "error" || result.errorMessage) {
		result.status = "error";
	} else {
		result.status = "ok";
	}

	result.durationMs = Date.now() - startedAt;
	options.onUpdate?.(result);
	return result;
}

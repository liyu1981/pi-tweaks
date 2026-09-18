/**
 * pt-subagent
 *
 * Run a task in an isolated subagent with its own model, then keep the
 * conversation in the transcript as a foldable entry (Ctrl+O to expand).
 *
 * Usage:
 *   /pt-subagent                              - manage subagent profiles (TUI)
 *   /pt-subagent -p <profile> <prompt...>     - run a named profile
 *   /pt-subagent <prompt...>                  - pick a profile (TUI), then run
 *
 * Profiles (name + provider/model) live in the shared pi-tweaks settings file,
 * section `subagent`. When the model is an OpenRouter model with a provider
 * lock, the lock is applied by passing the `<baseId>:<provider>` variant id to
 * the child; the child's pt-openrouter-lock-provider extension strips it again
 * and sets OpenRouter's `provider.order`.
 *
 * The child runs as a separate `pi --mode json` process, so it has an isolated
 * context window and full tool access. Its conversation is shown live (Esc
 * aborts), and the result is stored with pi.appendEntry as TUI-only content
 * (never injected into the parent LLM context).
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Editor,
	Key,
	Markdown,
	matchesKey,
	SelectList,
	Spacer,
	Text,
	wrapTextWithAnsi,
	type AutocompleteItem,
	type Component,
	type EditorTheme,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";
import { baseIdOf, getLock, listLocks, makeVariantId, OPENROUTER_PROVIDER } from "../src/openrouter";
import {
	getSettings,
	loadSettings,
	updateSettings,
	type SubagentProfile,
} from "../src/store";
import {
	formatToolCall,
	formatUsageStats,
	runSubagent,
	type DisplayItem,
	type SubagentRunResult,
	type SubagentUsage,
} from "../src/subagent";

// ─── Constants ──────────────────────────────────────────────────────────

const ENTRY_TYPE = "pt-subagent-run";
const STATUS_KEY = "pt-subagent";
const MAX_VISIBLE_PROFILES = 15;
const COLLAPSED_ITEM_COUNT = 8;
const MAX_ITEM_CHARS = 8 * 1024;
const MAX_OUTPUT_CHARS = 32 * 1024;

// ─── Entry data ─────────────────────────────────────────────────────────

interface SubagentEntryData {
	profile: string;
	provider: string;
	modelArg: string;
	baseModel: string;
	lockProvider?: string;
	task: string;
	status: SubagentRunResult["status"];
	stopReason?: string;
	errorMessage?: string;
	stderr?: string;
	displayItems: DisplayItem[];
	finalOutput: string;
	usage: SubagentUsage;
	durationMs: number;
}

function capText(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/**
 * Drop the expected resolver warning emitted for OpenRouter lock variant ids
 * (`openrouter/<base>:<lock>`), which pi reports as an unknown model id before
 * our lock extension strips the suffix. Real stderr output is kept.
 */
function cleanStderr(stderr: string): string | undefined {
	const cleaned = stderr
		.split("\n")
		.filter(
			(line) =>
				!/^Warning: Model ".*" not found for provider ".*".*Using custom model id\.?$/.test(
					line.trim(),
				),
		)
		.join("\n")
		.trim();
	return cleaned || undefined;
}

function toEntryData(result: SubagentRunResult): SubagentEntryData {
	const stderr = cleanStderr(result.stderr);
	return {
		profile: result.profile,
		provider: result.provider,
		modelArg: result.modelArg,
		baseModel: result.baseModel,
		lockProvider: result.lockProvider,
		task: result.task,
		status: result.status,
		stopReason: result.stopReason,
		errorMessage: result.errorMessage,
		stderr: stderr ? capText(stderr, 4096) : undefined,
		displayItems: result.displayItems.map((item) =>
			item.type === "text" ? { type: "text", text: capText(item.text, MAX_ITEM_CHARS) } : item,
		),
		finalOutput: capText(result.finalOutput, MAX_OUTPUT_CHARS),
		usage: result.usage,
		durationMs: result.durationMs,
	};
}

// ─── Profile helpers ────────────────────────────────────────────────────

function getProfiles(): SubagentProfile[] {
	return getSettings().subagent.profiles;
}

function sanitizeName(name: string): string {
	return name.trim().replace(/\s+/g, "-");
}

function displayModel(profile: SubagentProfile, locks: Record<string, string>): string {
	const lock = profile.provider === OPENROUTER_PROVIDER ? locks[profile.model] : undefined;
	return `${profile.provider}/${profile.model}${lock ? `:${lock}` : ""}`;
}

interface ResolvedRunModel {
	provider: string;
	baseModel: string;
	lockProvider?: string;
	modelArg: string;
}

async function resolveRunModel(profile: SubagentProfile): Promise<ResolvedRunModel> {
	const baseModel = await baseIdOf(profile.model);
	const lockProvider = profile.provider === OPENROUTER_PROVIDER ? await getLock(baseModel) : undefined;
	const modelId = lockProvider ? makeVariantId(baseModel, lockProvider) : baseModel;
	return {
		provider: profile.provider,
		baseModel,
		lockProvider,
		modelArg: `${profile.provider}/${modelId}`,
	};
}

/**
 * The extra system prompt appended to every subagent child. Also shown verbatim
 * in the task-prompt TUI so the user knows what the subagent starts with.
 */
function buildSubagentSystemPrompt(cwd: string): string {
	return [
		"You are an isolated pi subagent launched by the /pt-subagent command.",
		`Current working directory: ${cwd}`,
		"Follow the project instructions (AGENTS.md, AGENTS.override.md, or CLAUDE.md) for this directory.",
		"If they are not already present in your context, locate and read them before making changes.",
	].join("\n");
}

// ─── Model picker ───────────────────────────────────────────────────────

async function pickModel(
	ctx: ExtensionContext,
	current?: { provider: string; model: string },
): Promise<{ provider: string; model: string } | undefined> {
	const models = ctx.modelRegistry.getAvailable();
	if (models.length === 0) {
		ctx.ui.notify("No models available. Check your API keys.", "warning");
		return undefined;
	}

	const items: SelectItem[] = models
		.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}` }))
		.sort((a, b) => a.value.localeCompare(b.value));
	const currentValue = current ? `${current.provider}/${current.model}` : undefined;

	const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let searchTerm = "";

		const container = new Container();
		container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Select model for profile")), 1, 0));
		const searchLine = {
			render: () => [
				searchTerm
					? theme.fg("muted", `  search: ${searchTerm}`)
					: theme.fg("dim", "  type to search"),
			],
			invalidate: () => {},
		};
		container.addChild(searchLine);

		const selectList = new SelectList(items, Math.min(items.length, 15), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		if (currentValue) {
			const idx = items.findIndex((item) => item.value === currentValue);
			if (idx >= 0) selectList.setSelectedIndex(idx);
		}
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, Key.backspace) || data === "\x7f") {
					if (searchTerm) {
						searchTerm = searchTerm.slice(0, -1);
						selectList.setFilter(searchTerm);
						tui.requestRender();
					}
					return;
				}
				if (matchesKey(data, Key.escape) && searchTerm) {
					searchTerm = "";
					selectList.setFilter("");
					tui.requestRender();
					return;
				}
				if (data.length === 1 && data >= " " && data < "\x7f") {
					searchTerm += data;
					selectList.setFilter(searchTerm);
					tui.requestRender();
					return;
				}
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!selected) return undefined;
	const slash = selected.indexOf("/");
	return { provider: selected.slice(0, slash), model: selected.slice(slash + 1) };
}

// ─── Profile list / task prompt ─────────────────────────────────────────

type ProfileListAction =
	| { action: "task"; name: string }
	| { action: "add" }
	| { action: "edit"; name: string }
	| { action: "delete"; name: string };

async function showProfileList(
	ctx: ExtensionContext,
	profiles: SubagentProfile[],
	locks: Record<string, string>,
): Promise<ProfileListAction | undefined> {
	const title = "Subagent profiles";

	return ctx.ui.custom<ProfileListAction | undefined>((tui, theme, _kb, done) => {
		let cursor = 0;
		let scrollOffset = 0;
		let cached: string[] | undefined;

		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};

		const move = (delta: number) => {
			if (profiles.length === 0) return;
			cursor = Math.max(0, Math.min(profiles.length - 1, cursor + delta));
			if (cursor < scrollOffset) scrollOffset = cursor;
			if (cursor >= scrollOffset + MAX_VISIBLE_PROFILES)
				scrollOffset = cursor - MAX_VISIBLE_PROFILES + 1;
			refresh();
		};

		const hints = "↑↓ navigate • enter task • e edit • a add • d delete • esc close";

		const render = (width: number): string[] => {
			if (cached) return cached;
			const rw = Math.max(1, width);
			const lines: string[] = [];
			lines.push(theme.fg("accent", "─".repeat(rw)));
			lines.push(theme.fg("text", theme.bold(` ${title}`)));
			lines.push(theme.fg("dim", ` ${profiles.length} profile(s)`));
			lines.push("");

			if (profiles.length === 0) {
				lines.push(theme.fg("muted", "  No profiles yet. Press 'a' to add one."));
			} else {
				const visible = profiles.slice(scrollOffset, scrollOffset + MAX_VISIBLE_PROFILES);
				for (let i = 0; i < visible.length; i++) {
					const p = visible[i];
					const isSelected = scrollOffset + i === cursor;
					const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
					const name = theme.fg(isSelected ? "accent" : "text", theme.bold(p.name));
					const model = theme.fg("muted", displayModel(p, locks));
					const row = `${prefix}${name}  ${model}`;
					for (const wrapped of wrapTextWithAnsi(row, rw)) lines.push(wrapped);
				}
				if (profiles.length > MAX_VISIBLE_PROFILES) {
					const end = Math.min(scrollOffset + MAX_VISIBLE_PROFILES, profiles.length);
					lines.push(theme.fg("dim", ` ${scrollOffset + 1}-${end} of ${profiles.length}`));
				}
			}

			lines.push("");
			lines.push(theme.fg("dim", `  ${hints}`));
			lines.push(theme.fg("accent", "─".repeat(rw)));
			cached = lines;
			return lines;
		};

		const handleInput = (data: string) => {
			if (profiles.length === 0) {
				if (data === "a") done({ action: "add" });
				else if (matchesKey(data, Key.escape)) done(undefined);
				return;
			}
			if (matchesKey(data, Key.up)) return move(-1);
			if (matchesKey(data, Key.down)) return move(1);
			if (matchesKey(data, Key.enter)) {
				done({ action: "task", name: profiles[cursor].name });
				return;
			}
			if (data === "e") {
				done({ action: "edit", name: profiles[cursor].name });
				return;
			}
			if (data === "a") {
				done({ action: "add" });
				return;
			}
			if (data === "d") {
				done({ action: "delete", name: profiles[cursor].name });
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}
		};

		return {
			render,
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
		};
	});
}

/**
 * Task prompt phase: show the chosen profile and the system prompt the child
 * will receive, plus a multi-line editor. Enter runs the task; Ctrl+J (or
 * Shift+Enter) inserts a newline; Esc returns to the profile list.
 */
async function showTaskPrompt(
	ctx: ExtensionContext,
	profile: SubagentProfile,
	prefill?: string,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") return undefined;

	const locks = await listLocks();
	const modelDisplay = displayModel(profile, locks);
	const systemPrompt = buildSubagentSystemPrompt(ctx.cwd);

	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		let focused = true;

		const container = new Container();
		container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(" Subagent task")), 1, 0));
		container.addChild(
			new Text(
				theme.fg("muted", "  profile: ") +
					theme.fg("text", theme.bold(profile.name)) +
					theme.fg("dim", `  ${modelDisplay}`),
				1,
				0,
			),
		);

		// Width-aware so long system-prompt lines wrap inside the panel.
		const systemPromptBlock = {
			render: (width: number): string[] => {
				const out: string[] = [theme.fg("muted", "  system prompt:")];
				for (const line of systemPrompt.split("\n")) {
					for (const wrapped of wrapTextWithAnsi(theme.fg("dim", `    ${line}`), Math.max(1, width))) {
						out.push(wrapped);
					}
				}
				return out;
			},
			invalidate: () => {},
		};
		container.addChild(systemPromptBlock);

		const editorTheme: EditorTheme = {
			borderColor: (str: string) => theme.fg("accent", str),
			selectList: getSelectListTheme(),
		};
		const editor = new Editor(tui, editorTheme, { paddingX: 1 });
		editor.onSubmit = (text: string) => {
			const task = text.trim();
			if (task) done(task);
		};
		editor.onChange = () => tui.requestRender();
		editor.setText(prefill ?? "");
		editor.focused = true;
		container.addChild(editor);
		container.addChild(new Text(theme.fg("dim", "  enter run • ctrl+j newline • esc back"), 1, 0));
		container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));

		return {
			get focused(): boolean {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
				editor.focused = value;
			},
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, Key.escape) || data === "\u0003") {
					done(undefined);
					return;
				}
				editor.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

// ─── Profile CRUD ───────────────────────────────────────────────────────

async function addProfile(ctx: ExtensionContext): Promise<void> {
	const input = await ctx.ui.input("Profile name:");
	if (input === undefined) return;
	const name = sanitizeName(input);
	if (!name) {
		ctx.ui.notify("Profile name cannot be empty", "warning");
		return;
	}
	if (getProfiles().some((p) => p.name === name)) {
		ctx.ui.notify(`Profile "${name}" already exists`, "warning");
		return;
	}
	const model = await pickModel(ctx);
	if (!model) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}
	await updateSettings((draft) => {
		draft.subagent.profiles.push({ name, provider: model.provider, model: model.model });
	});
	ctx.ui.notify(`Added subagent profile "${name}" → ${model.provider}/${model.model}`, "info");
}

async function editProfile(ctx: ExtensionContext, name: string): Promise<void> {
	const existing = getProfiles().find((p) => p.name === name);
	if (!existing) return;

	// `ctx.ui.input`'s second argument is a placeholder, not a prefill, so an
	// empty submission keeps the existing name.
	const input = await ctx.ui.input("Profile name (empty to keep):", existing.name);
	if (input === undefined) return;
	const newName = sanitizeName(input) || existing.name;
	if (!newName) {
		ctx.ui.notify("Profile name cannot be empty", "warning");
		return;
	}
	if (getProfiles().some((p) => p.name === newName && p.name !== existing.name)) {
		ctx.ui.notify(`Profile "${newName}" already exists`, "warning");
		return;
	}

	const model = await pickModel(ctx, { provider: existing.provider, model: existing.model });
	if (!model) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	await updateSettings((draft) => {
		const profile = draft.subagent.profiles.find((p) => p.name === existing.name);
		if (!profile) return;
		profile.name = newName;
		profile.provider = model.provider;
		profile.model = model.model;
	});
	ctx.ui.notify(`Updated subagent profile "${newName}" → ${model.provider}/${model.model}`, "info");
}

async function deleteProfile(ctx: ExtensionContext, name: string): Promise<void> {
	const ok = await ctx.ui.confirm("Delete subagent profile?", `Delete "${name}"?`);
	if (!ok) return;
	await updateSettings((draft) => {
		draft.subagent.profiles = draft.subagent.profiles.filter((p) => p.name !== name);
	});
	ctx.ui.notify(`Deleted subagent profile "${name}"`, "info");
}

async function manageProfiles(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	prefillTask?: string,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Usage: /pt-subagent -p <profile> <prompt>", "info");
		return;
	}

	let prefill = prefillTask;
	for (;;) {
		const profiles = getProfiles();
		const locks = await listLocks();
		const res = await showProfileList(ctx, profiles, locks);
		if (!res) return;

		if (res.action === "add") {
			await addProfile(ctx);
			continue;
		}
		if (res.action === "edit") {
			await editProfile(ctx, res.name);
			continue;
		}
		if (res.action === "delete") {
			await deleteProfile(ctx, res.name);
			continue;
		}

		// Enter on a profile: task prompt phase.
		const profile = getProfiles().find((p) => p.name === res.name);
		if (!profile) continue;
		const task = await showTaskPrompt(ctx, profile, prefill);
		prefill = undefined;
		if (task === undefined) continue; // Esc: back to the profile list
		await executeProfileTask(ctx, pi, profile, task);
		return;
	}
}

// ─── Live view ──────────────────────────────────────────────────────────

class LiveRunComponent implements Component {
	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly getState: () => SubagentRunResult,
		private readonly onAbort: () => void,
	) {}

	invalidate(): void {
		// No cached render state; always redraw from the latest run state.
	}

	handleInput(data: string): void {
		// Esc or Ctrl+C aborts the running subagent.
		if (matchesKey(data, Key.escape) || data === "\u0003") this.onAbort();
	}

	render(width: number): string[] {
		const t = this.theme;
		const rw = Math.max(1, width);
		const s = this.getState();

		const icon =
			s.status === "running"
				? t.fg("warning", "⏳")
				: s.status === "ok"
					? t.fg("success", "✓")
					: s.status === "aborted"
						? t.fg("warning", "⊘")
						: t.fg("error", "✗");

		const lines: string[] = [];
		lines.push(t.fg("accent", "─".repeat(rw)));
		lines.push(
			`${icon} ${t.fg("toolTitle", t.bold("subagent "))}${t.fg("accent", s.profile)} ` +
				t.fg("muted", `[${s.modelArg}]`),
		);
		lines.push(t.fg("dim", `  task: ${s.task}`));
		lines.push("");

		const items = s.displayItems;
		const shown = items.slice(-COLLAPSED_ITEM_COUNT);
		const skipped = items.length - shown.length;
		if (skipped > 0) lines.push(t.fg("muted", `  ... ${skipped} earlier items`));
		if (shown.length === 0) {
			lines.push(t.fg("muted", "  (waiting for output...)"));
		} else {
			for (const item of shown) {
				if (item.type === "text") {
					const preview = item.text.split("\n").slice(0, 3).join("\n");
					for (const line of preview.split("\n")) lines.push(t.fg("toolOutput", `  ${line}`));
				} else {
					lines.push(t.fg("muted", "  → ") + formatToolCall(item.name, item.args, t.fg.bind(t)));
				}
			}
		}

		lines.push("");
		const usage = formatUsageStats(s.usage);
		if (usage) lines.push(t.fg("dim", `  ${usage}`));
		lines.push(t.fg("dim", "  Esc to abort"));
		lines.push(t.fg("accent", "─".repeat(rw)));

		const out: string[] = [];
		for (const line of lines) out.push(...wrapTextWithAnsi(line, rw));
		return out;
	}
}

// ─── Entry renderer ─────────────────────────────────────────────────────

function renderSubagentEntry(data: SubagentEntryData, expanded: boolean, theme: Theme): Component {
	const t = theme;
	const icon =
		data.status === "ok"
			? t.fg("success", "✓")
			: data.status === "aborted"
				? t.fg("warning", "⊘")
				: t.fg("error", "✗");
	const lockTag = data.lockProvider ? t.fg("dim", ` (locked: ${data.lockProvider})`) : "";
	const header =
		`${icon} ${t.fg("toolTitle", t.bold("subagent "))}${t.fg("accent", data.profile)} ` +
		`${t.fg("muted", `[${data.modelArg}]`)}${lockTag}`;

	const usageStr = formatUsageStats(data.usage);

	if (!expanded) {
		let text = header;
		if (data.status !== "ok" && data.stopReason) text += ` ${t.fg("error", `[${data.stopReason}]`)}`;
		if (data.status !== "ok" && data.errorMessage)
			text += `\n${t.fg("error", `Error: ${data.errorMessage}`)}`;

		const shown = data.displayItems.slice(-COLLAPSED_ITEM_COUNT);
		const skipped = data.displayItems.length - shown.length;
		let body = "";
		if (skipped > 0) body += `${t.fg("muted", `... ${skipped} earlier items`)}\n`;
		if (shown.length === 0) body += t.fg("muted", "(no output)");
		else {
			for (const item of shown) {
				if (item.type === "text")
					body += `${t.fg("toolOutput", item.text.split("\n").slice(0, 3).join("\n"))}\n`;
				else body += `${t.fg("muted", "→ ") + formatToolCall(item.name, item.args, t.fg.bind(t))}\n`;
			}
			body = body.trimEnd();
		}
		text += `\n${body}`;
		if (usageStr) text += `\n${t.fg("dim", usageStr)}`;
		text += `\n${t.fg("muted", "(Ctrl+O to expand)")}`;
		return new Text(text, 0, 0);
	}

	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	if (data.status !== "ok" && data.errorMessage)
		container.addChild(new Text(t.fg("error", `Error: ${data.errorMessage}`), 0, 0));
	if (data.stderr) container.addChild(new Text(t.fg("dim", `stderr: ${data.stderr}`), 0, 0));

	container.addChild(new Spacer(1));
	container.addChild(new Text(t.fg("muted", "─── Task ───"), 0, 0));
	container.addChild(new Text(t.fg("dim", data.task), 0, 0));

	container.addChild(new Spacer(1));
	container.addChild(new Text(t.fg("muted", "─── Conversation ───"), 0, 0));
	if (data.displayItems.length === 0) {
		container.addChild(new Text(t.fg("muted", "(no output)"), 0, 0));
	} else {
		for (const item of data.displayItems) {
			if (item.type === "toolCall") {
				container.addChild(
					new Text(
						t.fg("muted", "→ ") + formatToolCall(item.name, item.args, t.fg.bind(t)),
						0,
						0,
					),
				);
			} else {
				container.addChild(new Text(t.fg("toolOutput", item.text.trimEnd()), 0, 0));
			}
		}
	}

	if (data.finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(t.fg("muted", "─── Final output ───"), 0, 0));
		container.addChild(new Markdown(data.finalOutput.trim(), 0, 0, getMarkdownTheme()));
	}

	if (usageStr) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(t.fg("dim", usageStr), 0, 0));
	}
	return container;
}

// ─── Run orchestration ──────────────────────────────────────────────────

function emptyResultState(
	run: {
		profile: string;
		provider: string;
		modelArg: string;
		baseModel: string;
		lockProvider?: string;
		task: string;
	},
): SubagentRunResult {
	return {
		profile: run.profile,
		provider: run.provider,
		modelArg: run.modelArg,
		baseModel: run.baseModel,
		lockProvider: run.lockProvider,
		task: run.task,
		status: "running",
		stderr: "",
		messages: [],
		displayItems: [],
		finalOutput: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		durationMs: 0,
	};
}

async function executeProfileTask(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	profile: SubagentProfile,
	task: string,
): Promise<void> {
	const resolved = await resolveRunModel(profile);
	const runOptions = {
		cwd: ctx.cwd,
		profile: profile.name,
		provider: resolved.provider,
		modelArg: resolved.modelArg,
		baseModel: resolved.baseModel,
		lockProvider: resolved.lockProvider,
		task,
		trustProject: ctx.isProjectTrusted(),
		systemPrompt: buildSubagentSystemPrompt(ctx.cwd),
	};

	// Non-TUI modes (json/print/rpc): run without the interactive live view.
	if (ctx.mode !== "tui") {
		ctx.ui.setStatus(STATUS_KEY, `subagent ${profile.name} running…`);
		try {
			const result = await runSubagent(runOptions);
			pi.appendEntry(ENTRY_TYPE, toEntryData(result));
			if (result.status !== "ok")
				ctx.ui.notify(`subagent ${profile.name}: ${result.status}`, "warning");
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		return;
	}

	const abort = new AbortController();
	let state = emptyResultState(runOptions);

	const livePromise = ctx.ui.custom<SubagentRunResult>((tui, theme, _kb, done) => {
		const component = new LiveRunComponent(
			tui,
			theme,
			() => state,
			() => abort.abort(),
		);
		runSubagent({
			...runOptions,
			signal: abort.signal,
			onUpdate: (partial) => {
				state = partial;
				tui.requestRender();
			},
		})
			.then((result) => {
				state = result;
				done(result);
			})
			.catch((error) => {
				state = {
					...state,
					status: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
				};
				done(state);
			});
		return component;
	});

	const result = await livePromise;

	pi.appendEntry(ENTRY_TYPE, toEntryData(result));
	if (result.status === "aborted") ctx.ui.notify(`subagent ${profile.name} aborted`, "warning");
	else if (result.status === "error") ctx.ui.notify(`subagent ${profile.name} failed`, "error");
}

/** Direct `/pt-subagent -p <profile> [prompt]` path, bypassing the profile list. */
async function runProfileByName(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	name: string,
	prompt: string | undefined,
): Promise<void> {
	const profile = getProfiles().find((p) => p.name === name);
	if (!profile) {
		const names = getProfiles().map((p) => p.name).join(", ") || "none";
		ctx.ui.notify(`Unknown subagent profile "${name}". Available: ${names}`, "warning");
		return;
	}

	const task = prompt?.trim();
	if (task) {
		await executeProfileTask(ctx, pi, profile, task);
		return;
	}

	// No prompt supplied: open the task prompt phase for this profile.
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Usage: /pt-subagent -p <profile> <prompt>", "warning");
		return;
	}
	const input = await showTaskPrompt(ctx, profile);
	if (input !== undefined) await executeProfileTask(ctx, pi, profile, input);
}

// ─── Extension ──────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	await loadSettings();

	pi.registerEntryRenderer<SubagentEntryData>(ENTRY_TYPE, (entry, { expanded }, theme) =>
		entry.data ? renderSubagentEntry(entry.data, expanded, theme) : undefined,
	);

	pi.registerCommand("pt-subagent", {
		description: "Run a task in an isolated subagent profile (TUI-managed, model + lock aware)",

		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const profiles = getProfiles();
			const profileItems: AutocompleteItem[] = profiles.map((p) => ({
				value: p.name,
				label: p.name,
				description: `${p.provider}/${p.model}`,
			}));

			if (prefix.startsWith("-p ")) {
				const namePrefix = prefix.slice(3);
				const filtered = profileItems.filter((item) => item.value.startsWith(namePrefix));
				return filtered.length > 0 ? filtered : null;
			}

			const flag: AutocompleteItem = {
				value: "-p ",
				label: "-p <profile>",
				description: "Run a named profile",
			};
			const filtered = profileItems.filter((item) => item.value.startsWith(prefix));
			return [flag, ...filtered].slice(0, 20);
		},

		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();

			// No arguments: open the profile list TUI.
			if (!raw) {
				await manageProfiles(ctx, pi);
				return;
			}

			// `/pt-subagent -p <profile> [prompt...]`
			if (raw === "-p" || raw.startsWith("-p ")) {
				const match = /^-p\s+"?([^\s"]+)"?\s*([\s\S]*)$/.exec(raw);
				if (!match) {
					ctx.ui.notify("Usage: /pt-subagent -p <profile> [prompt]", "warning");
					return;
				}
				await runProfileByName(ctx, pi, match[1], match[2].trim() || undefined);
				return;
			}

			// Anything else is a task prompt: open the profile list, then the task
			// prompt phase pre-filled with this text.
			await manageProfiles(ctx, pi, raw);
		},
	});
}

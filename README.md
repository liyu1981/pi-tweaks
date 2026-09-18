# @liyu1981/pi-tweaks

A small collection of [pi](https://pi.dev) extensions bundled as one pi package.
It fixes four everyday annoyances when you use pi with a mixed model set:

1. **Pi forgets your model.** Every new session starts on whatever is in
   `settings.json`, so you re-pick by hand. → **remember-model** remembers the
   model you last selected and restores it next session.
2. **OpenRouter routes to a random upstream provider.** The same model id can be
   served by backends with different speed/quality/price. →
   **openrouter-lock-provider** pins a model to the upstream provider you choose.
3. **You accidentally chat with the wrong model.** A stray Ctrl+P or `/model` can
   send a prompt to a costly or weak model. → **model-preference-guard** warns and
   asks for confirmation before a prompt leaves for a model outside your
   allow-list.
4. **Delegating a focused task means polluting your context or juggling another
   terminal.** → **subagent** runs a task in an isolated `pi` process on a named
   profile (its own model), then folds the captured conversation into your
   session, expandable with Ctrl+O and abortable with Esc.

All features share one settings file and all commands are prefixed with `pt-`.

## Install

```bash
# from npm (once published)
pi install npm:@liyu1981/pi-tweaks
pi install npm:@liyu1981/pi-tweaks@0.1.0   # pinned

# from GitHub
pi install git:github.com/liyu1981/pi-tweaks
```

Try it without installing:

```bash
pi -e npm:@liyu1981/pi-tweaks
pi -e git:github.com/liyu1981/pi-tweaks
```

## TUI configuration

Several commands open interactive pickers, styled like pi's own `/model` picker.

### Model multi-select picker

Used by `/pt-model-guard-pref` (no args, or `add` / `remove`).

| Key | Action |
| --- | --- |
| type | substring-filter on `provider/model` |
| ↑ / ↓ | move cursor |
| Space | toggle highlighted model (and advance) |
| `a` / `n` | select all / none (only while the search box is empty) |
| Enter | confirm selection |
| Esc | clear search, or cancel if search is already empty |

- `☑` checked, `☐` unchecked; models without a configured API key show `⚠ no key`.
- Checked models sort first, then keyed models, then alphabetically; 20 rows are
  visible at a time with a scroll indicator.

### Provider-lock picker

Used by `/pt-openrouter-lock-provider` with no arguments.

| Key | Action |
| --- | --- |
| type | filter model ids |
| ↑ / ↓ | move cursor |
| Backspace | delete a search character |
| Esc | clear search, or cancel if empty |
| Enter | pick the highlighted model |

After picking, a one-line text prompt asks for the provider slug (empty clears
the lock).

### Subagent profile list

Opened by `/pt-subagent` (and shown before the task prompt when you run
`/pt-subagent <text>`).

| Key | Action |
| --- | --- |
| ↑ / ↓ | move cursor |
| Enter | open the **task prompt** phase for the highlighted profile |
| `e` | edit the highlighted profile (name, then model picker) |
| `a` | add a profile (asks for a name, then opens the model picker) |
| `d` | delete the highlighted profile (with confirmation) |
| Esc | close |

Each row shows `name` and its `provider/model`, with `:provider` appended when
an OpenRouter provider lock is set.

### Subagent task prompt

Shown after choosing a profile. It lists the profile and the system prompt the
subagent will receive, then gives you a multi-line editor for the task.

| Key | Action |
| --- | --- |
| Enter | run the task |
| Ctrl+J / Shift+Enter | insert a newline |
| Esc | back to the profile list |

### Confirmation prompt

`model-preference-guard` uses pi's standard Yes/No confirm before sending a
prompt to a non-allow-listed model; declining cancels the send.

## Commands

| Command | Description |
| --- | --- |
| `/pt-remember-model [status\|on\|off\|clear]` | Remember and restore the last selected model. |
| `/pt-openrouter-lock-provider [<provider>\|clear\|list\|on\|off]` | Manage OpenRouter provider locks. No argument opens a TUI picker. |
| `/pt-model-guard-pref [list\|on\|off\|toggle\|add\|remove]` | Manage the allowed-model list. No argument opens a multi-select picker. |
| `/pt-subagent [\-p <profile> [prompt]]` | No argument: profile list → task prompt. With `-p <profile>`: run directly (or open the task prompt if no prompt given). Otherwise the text is the task prompt; the profile list opens first. |

Every feature has an on/off switch and defaults to **on**. Turning off
`openrouter-lock-provider` also stops `remember-model` from appending the
`:<provider>` suffix to the default model.

## Settings

Everything is stored in one file:

```
~/.pi/agent/pi-tweaks-settings.json
```

```jsonc
{
  "version": 1,

  // /pt-remember-model
  "rememberModel": {
    "enabled": true,
    "last": { "provider": "openrouter", "modelId": "deepseek/deepseek-v4.1-flash" }
  },

  // /pt-model-guard-pref
  "modelGuard": {
    "enabled": true,
    "allowedModels": [
      { "provider": "openrouter", "model": "deepseek/deepseek-v4.1-flash" }
    ]
  },

  // /pt-openrouter-lock-provider (base model id -> upstream provider slug)
  "openrouterModelProviderPref": {
    "enabled": true,
    "locks": { "deepseek/deepseek-v4.1-flash": "deepseek" }
  },

  // /pt-subagent (named profiles; OpenRouter locks applied at run time)
  "subagent": {
    "profiles": [
      { "name": "scout", "provider": "openrouter", "model": "deepseek/deepseek-v4.1-flash" }
    ]
  }
}
```

Missing sections are filled with defaults on load. Writes are serialized and atomic, so the extensions can safely update the file concurrently.

## How features work

### remember-model

On every model selection it saves the model to `rememberModel.last` and writes `defaultProvider` / `defaultModel` into pi's own `settings.json`. On `new` / `startup` sessions it restores that model. Toggle with `/pt-remember-model on|off`; forget the saved model with `/pt-remember-model clear`.

If the model is an OpenRouter model with a provider lock, the model written to pi's settings uses a `:<provider>` suffix, e.g. `deepseek/deepseek-v4.1-flash:deepseek`. pi's resolver does not understand that suffix, so the extension restores the base model itself at session start.

### openrouter-lock-provider

OpenRouter routes a model across several upstream providers. A lock pins one:

```bash
/pt-openrouter-lock-provider deepseek
/pt-openrouter-lock-provider clear
/pt-openrouter-lock-provider list
```

At request time the extension sets OpenRouter's `provider.order` to your locked provider and strips the `:<provider>` suffix so OpenRouter never sees it. Disable the whole feature with `/pt-openrouter-lock-provider off`; while off, `remember-model` writes the plain base model id (no suffix) and no routing is applied.

### model-preference-guard

Maintain an allow-list of preferred `provider/model` combinations. When you type a prompt with a model outside the list, pi asks for confirmation first. With an empty list the guard allows everything. Disable temporarily with `/pt-model-guard-pref toggle`.

### subagent

Define named profiles (`name` + `provider/model`) with `/pt-subagent`. Running
it without arguments opens the profile list; press Enter to move to the task
prompt phase, which shows the chosen profile and its system prompt and gives
you a multi-line editor (Enter runs, Ctrl+J adds a newline, Esc goes back).

`/pt-subagent -p scout summarize the README` runs that profile directly, and
`/pt-subagent summarize the README` opens the profile list first with the task
pre-filled. A run spawns an isolated `pi --mode json` process on the chosen
profile, streams its tool calls and output live, and stores the captured
conversation in the transcript as a foldable entry (Ctrl+O to expand, Esc to
abort).

The subagent conversation is display-only: it never enters your parent session's
LLM context. OpenRouter provider locks apply automatically — the profile's base
model id is turned into the `<model>:<provider>` variant for the child, whose
`openrouter-lock-provider` handler strips the suffix and sets
OpenRouter's `provider.order`.

The child mirrors the parent's **project-trust** decision (`--approve` /
`--no-approve`). This matters because project system-prompt files
(`.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`), project settings, extensions and
skills are trust-gated: without `--approve` a non-interactive child would
silently drop them even though your interactive session loaded them. The child
is also given an explicit system-prompt preamble stating its working directory
and instructing it to follow the project instructions (`AGENTS.md`,
`AGENTS.override.md`, or `CLAUDE.md`) — reading them first if they are not
already in context.

## Local development

No build step: pi loads TypeScript directly via jiti.

```bash
npm install        # once, for the type-checker and dev deps
npm run check      # tsc --noEmit
```

### Validate against a local pi (no install)

Loads this working tree as a package for a single run. Edits are picked up on
the next run.

```bash
npm run dev                                  # pi -e .
npm run dev -- --model openrouter/deepseek/deepseek-v4.1-flash

# or directly
pi -e .
```

### Install this working tree into pi (live path)

Installs this directory into pi's settings as a **local package**. The path is
referenced, not copied, so pi keeps loading the current working tree —
including uncommitted changes — until you remove it. This is the way to test the
latest code before pushing to GitHub or publishing to npm.

```bash
npm run install:local      # pi install .
npm run uninstall:local    # pi remove .
```

After installing, restart pi (or run `/reload` in the TUI) to pick up edits.

> **Avoid duplicate handlers.** If you previously loaded the standalone files,
> remove them before installing this package, otherwise both sets run:
>
> ```bash
> rm ~/.pi/agent/extensions/pt-remember-model.ts
> rm ~/.pi/agent/extensions/pt-model-guard.ts
> ```

### Pre-publish check

```bash
npm run check        # tsc --noEmit
npm run pack:check   # npm pack --dry-run: shows exactly which files would ship
```

### Publishing

The package is published publicly to the `@liyu1981` scope
(`publishConfig.access: "public"`), so a plain publish works:

```bash
npm version patch          # or minor / major
npm publish                # prepublishOnly runs `npm run check` first
git push --follow-tags
```

## License

MIT © Yu Li

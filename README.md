# @liyu1981/pi-tweaks

A small collection of [pi](https://pi.dev) extensions bundled as one pi package:

- **remember-model** — remembers the last selected model and restores it next session.
- **openrouter-lock-provider** — pins an OpenRouter model to a preferred upstream provider.
- **model-preference-guard** — warns when you are about to chat with a model you did not allow-list.

All features share a single settings file and all commands are prefixed with `pt-`.

## Install

```bash
pi install npm:@liyu1981/pi-tweaks
# or a pinned version
pi install npm:@liyu1981/pi-tweaks@0.1.0
```

Try it without installing:

```bash
pi -e npm:@liyu1981/pi-tweaks
```

Local development:

```bash
pi -e /path/to/pi-tweaks
```

## Commands

| Command | Description |
| --- | --- |
| `/pt-remember-model [status\|on\|off\|clear]` | Remember and restore the last selected model. |
| `/pt-openrouter-lock-provider [<provider>\|clear\|list]` | Manage OpenRouter provider locks. No argument opens a TUI picker. |
| `/pt-model-guard-pref [list\|toggle\|add\|remove]` | Manage the allowed-model list. No argument opens a multi-select picker. |

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
    "locks": { "deepseek/deepseek-v4.1-flash": "deepseek" }
  }
}
```

Missing sections are filled with defaults on load. Writes are serialized and atomic, so the three extensions can safely update the file concurrently.

### Legacy migration

On first run, if `pi-tweaks-settings.json` does not exist, it is seeded from the older per-feature files (left in place, not deleted):

| Legacy file | New location |
| --- | --- |
| `~/.pi/agent/last-model.json` | `rememberModel.last` |
| `~/.pi/agent/openrouter-provider-prefs.json` | `openrouterModelProviderPref.locks` |
| `~/.pi/agent/model-preferences.json` | `modelGuard` |

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

At request time the extension sets OpenRouter's `provider.order` to your locked provider and strips the `:<provider>` suffix so OpenRouter never sees it.

### model-preference-guard

Maintain an allow-list of preferred `provider/model` combinations. When you type a prompt with a model outside the list, pi asks for confirmation first. With an empty list the guard allows everything. Disable temporarily with `/pt-model-guard-pref toggle`.

## Development

No build step: pi loads TypeScript directly via jiti. Type-checking only:

```bash
npm install
npm run check
```

## License

MIT © Yu Li

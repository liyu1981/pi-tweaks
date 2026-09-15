/**
 * OpenRouter provider-lock helpers.
 *
 * A lock maps an OpenRouter base model id to a preferred upstream provider
 * slug, for example:
 *
 *   "deepseek/deepseek-v4.1-flash" -> "deepseek"
 *
 * The lock is persisted in the shared settings file (section
 * `openrouterModelProviderPref.locks`). At request time the lock is expressed
 * as OpenRouter's `provider.order`, and the `:<provider>` suffix that
 * `remember-model` writes into pi's `defaultModel` is stripped again.
 */

import { loadSettings, updateSettings } from "./store";

export const OPENROUTER_PROVIDER = "openrouter";
export const PROVIDER_SEP = ":";

/** `deepseek/deepseek-v4.1-flash` + `deepseek` -> `deepseek/deepseek-v4.1-flash:deepseek` */
export function makeVariantId(baseId: string, provider: string): string {
	return `${baseId}${PROVIDER_SEP}${provider}`;
}

/** Split a `model:provider` variant id, returning null when there is no usable suffix. */
export function splitVariant(id: string): { baseId: string; provider: string } | null {
	const idx = id.lastIndexOf(PROVIDER_SEP);
	if (idx <= 0 || idx === id.length - 1) return null;
	return { baseId: id.slice(0, idx), provider: id.slice(idx + 1) };
}

export async function listLocks(): Promise<Record<string, string>> {
	const settings = await loadSettings();
	return { ...settings.openrouterModelProviderPref.locks };
}

export async function getLock(baseId: string): Promise<string | undefined> {
	const locks = await listLocks();
	return locks[baseId];
}

export async function setLock(baseId: string, provider: string): Promise<void> {
	const trimmed = provider.trim();
	if (!trimmed) return;
	await updateSettings((draft) => {
		draft.openrouterModelProviderPref.locks[baseId] = trimmed;
	});
}

export async function clearLock(baseId: string): Promise<void> {
	await updateSettings((draft) => {
		delete draft.openrouterModelProviderPref.locks[baseId];
	});
}

/**
 * Strip our provider suffix when (and only when) it matches a stored lock,
 * leaving real catalog suffixes intact.
 */
export async function baseIdOf(id: string): Promise<string> {
	const split = splitVariant(id);
	if (!split) return id;
	const locks = await listLocks();
	return locks[split.baseId] === split.provider ? split.baseId : id;
}

/** Resolve the locked provider for a model id, ignoring any existing suffix. */
export async function resolveProviderPref(modelId: string): Promise<string | undefined> {
	const baseId = await baseIdOf(modelId);
	return getLock(baseId);
}

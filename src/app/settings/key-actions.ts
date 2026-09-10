"use server";

import { revalidatePath } from "next/cache";
import {
  getSetting,
  setSetting,
  deleteSetting,
  getCustomProviders,
  getCustomProvider,
  saveCustomProviders,
  type SettingKey,
} from "@/lib/settings-store";
import { encrypt } from "@/lib/crypto";
import {
  normalizeBaseUrl,
  removeCustomProvider,
  uniqueCustomId,
  type CustomProvider,
} from "@/lib/custom-providers";
import {
  isCustomProvider,
  PROVIDER_CATALOG,
  type ActiveProvider,
  type CustomProviderId,
  type Provider,
} from "@/lib/api-providers";

const ALLOWED_KEYS: Record<Provider, SettingKey> = {
  openai: "api.openai",
  anthropic: "api.anthropic",
  gemini: "api.gemini",
  perplexity: "api.perplexity",
  openrouter: "api.openrouter",
  groq: "api.groq",
  mistral: "api.mistral",
  deepseek: "api.deepseek",
  cerebras: "api.cerebras",
  together: "api.together",
  github: "api.github",
};

export async function saveApiKey(
  provider: Provider,
  formData: FormData,
): Promise<void> {
  const key = ALLOWED_KEYS[provider];
  if (!key) return;
  const raw = String(formData.get("value") ?? "").trim();
  if (raw === "") {
    await deleteSetting(key);
  } else {
    // Encrypt before persisting — see lib/crypto.ts
    await setSetting(key, encrypt(raw));
  }
  revalidatePath("/settings");
  revalidatePath("/ai-visibility");
}

export async function saveOllamaUrl(formData: FormData): Promise<void> {
  const raw = String(formData.get("value") ?? "").trim();
  if (raw === "") {
    await deleteSetting("api.ollama_url");
  } else {
    await setSetting("api.ollama_url", raw.replace(/\/+$/, ""));
  }
  revalidatePath("/settings");
  revalidatePath("/ai-visibility");
}

export async function setActiveProvider(
  provider: ActiveProvider,
): Promise<void> {
  // Full static catalog + ollama + any saved custom id. This used to be
  // a hardcoded 7-entry array, so mistral / deepseek / cerebras /
  // together / github buttons silently did nothing (no error, just a
  // dead click) and custom providers could never be activated.
  const allowed: ReadonlySet<string> = new Set([
    ...PROVIDER_CATALOG.map((p) => p.id),
    "ollama",
  ]);
  if (!allowed.has(provider) && !isCustomProvider(provider)) return;
  await setSetting("ai.active_provider", provider);
  revalidatePath("/settings");
  revalidatePath("/ai-visibility");
  revalidatePath("/", "layout");
}

export async function setCreditSaverEnabled(enabled: boolean): Promise<void> {
  await setSetting("ai.credit_saver.enabled", enabled);
  revalidatePath("/settings");
}

// ── Custom OpenAI-compatible providers ────────────────────────────
// Server actions backing the custom-providers card on /settings.
// All validation happens here (the client form is convenience only) —
// a crafted request bypassing the UI must not be able to persist a
// garbage endpoint or an unencrypted key.

/** Result of saveCustomProvider — lets the card show inline errors. */
export type CustomProviderSaveResult =
  | { ok: true; id: CustomProviderId }
  | { ok: false; error: string };

/**
 * Create or update one custom provider from the card's form.
 *
 * Field contract (FormData):
 *   id       — present ⇒ EDIT the saved entry with that id (absent ⇒ create)
 *   label    — required for create; on edit blank keeps the stored label
 *   baseUrl  — required for create; on edit blank keeps the stored URL
 *   model    — required for create; on edit blank keeps the stored model
 *              (lets the model picker persist just a model change)
 *   apiKey   — new plaintext key. Blank ⇒ keep stored key on edit (the
 *              card never round-trips the secret); on create ⇒ keyless
 *              endpoint (LM Studio / llama.cpp style)
 *   clearKey — "1" ⇒ explicitly drop the stored key (endpoint needs no auth)
 */
export async function saveCustomProvider(
  formData: FormData,
): Promise<CustomProviderSaveResult> {
  const editingId = String(formData.get("id") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const baseUrlRaw = String(formData.get("baseUrl") ?? "").trim();
  const model = String(formData.get("model") ?? "").trim();
  const newKey = String(formData.get("apiKey") ?? "").trim();
  const clearKey = String(formData.get("clearKey") ?? "") === "1";

  const existing = editingId ? await getCustomProvider(editingId) : undefined;
  if (editingId && !existing) {
    return {
      ok: false,
      error: "That custom provider no longer exists — refresh the page.",
    };
  }

  // Merge semantics per the contract above: on edit, blank fields fall
  // back to the stored values so partial saves (e.g. the model picker's
  // model-only update) never wipe other fields.
  const nextLabel = existing ? label || existing.label : label;
  const nextModel = existing ? model || existing.model : model;

  if (!nextLabel) return { ok: false, error: "A display name is required." };
  if (!nextModel) {
    return {
      ok: false,
      error:
        "A model id is required (e.g. qwen2.5-7b-instruct or gpt-4o-mini).",
    };
  }

  // URL: must parse as http(s) and gets trailing slashes stripped.
  // Trust class is the same as the Ollama URL the admin can already set
  // (admin-supplied, single-user local-first app) — no blocklist here,
  // but the scheme restriction keeps the later fetch() well-formed.
  // Blank on edit keeps the stored URL; blank on create is an error.
  let baseUrl: string;
  if (baseUrlRaw) {
    const normalized = normalizeBaseUrl(baseUrlRaw);
    if (!normalized) {
      return {
        ok: false,
        error:
          "Base URL must be a valid http:// or https:// URL, e.g. http://localhost:1234/v1",
      };
    }
    baseUrl = normalized;
  } else if (existing?.baseUrl) {
    baseUrl = existing.baseUrl;
  } else {
    return { ok: false, error: "A base URL is required." };
  }

  // Key: encrypt-at-rest like every built-in key (crypto.ts).
  let nextApiKey: string;
  if (clearKey) {
    nextApiKey = ""; // explicit "this endpoint needs no auth"
  } else if (newKey) {
    nextApiKey = encrypt(newKey);
  } else {
    nextApiKey = existing?.apiKey ?? ""; // blank edit ⇒ preserve stored
  }

  // Id: stable across edits (renaming the label keeps the id so saved
  // references — ai.active_provider, ai_calls rows — stay valid). New
  // entries get a unique custom:<slug> derived from the label.
  const id: CustomProviderId =
    existing?.id ?? uniqueCustomId(await getCustomProviders(), nextLabel);

  const entry: CustomProvider = {
    id,
    label: nextLabel,
    baseUrl,
    apiKey: nextApiKey,
    model: nextModel,
  };

  const list = await getCustomProviders();
  let nextList: CustomProvider[];
  if (existing) {
    nextList = list.map((p) => (p.id === id ? entry : p));
  } else {
    nextList = [...list, entry];
  }
  await saveCustomProviders(nextList);

  revalidatePath("/settings");
  revalidatePath("/ai-visibility");
  revalidatePath("/", "layout");
  return { ok: true, id };
}

/**
 * Remove a custom provider. If it was the ACTIVE provider, also drop
 * ai.active_provider so getActiveProvider() falls back to the first
 * configured provider instead of pointing at a ghost id.
 */
export async function deleteCustomProvider(id: string): Promise<void> {
  if (!isCustomProvider(id)) return;
  const list = await getCustomProviders();
  const nextList = removeCustomProvider(list, id);
  if (nextList.length === list.length) return; // id not saved — nothing to do
  await saveCustomProviders(nextList);
  const active = await getSetting<string>("ai.active_provider");
  if (active === id) await deleteSetting("ai.active_provider");
  revalidatePath("/settings");
  revalidatePath("/ai-visibility");
  revalidatePath("/", "layout");
}

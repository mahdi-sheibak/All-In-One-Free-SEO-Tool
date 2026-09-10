import {
  getSetting,
  setSetting,
  getCustomProvider,
  getCustomProviders,
} from "./settings-store";
import type { CustomProvider } from "./custom-providers";
import { decrypt, ensureEncrypted, isEncrypted } from "./crypto";
import {
  isCustomProvider,
  type ActiveProvider,
  type Provider,
} from "./api-providers";

// Re-exported for the ~20 modules that import these from here — the
// types moved to their real home (api-providers, client-safe) when
// custom providers were added, and this keeps existing call sites like
// `import type { ActiveProvider } from "@/lib/api-keys"` working.
export type {
  Provider,
  ActiveProvider,
  CustomProviderId,
  StaticProviderId,
} from "./api-providers";
export { PROVIDER_CATALOG, isCustomProvider } from "./api-providers";

const ENV_VAR: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  together: "TOGETHER_API_KEY",
  github: "GITHUB_TOKEN",
};

const SETTING_KEY: Record<Provider, `api.${Provider}`> = {
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

export async function getApiKey(
  provider: ActiveProvider,
): Promise<string | null> {
  // Custom providers keep their key INSIDE the custom_providers row
  // (not a per-provider api.* setting). Dispatching through this
  // function means callers never need to know the difference:
  //   saved + key   → decrypted plaintext
  //   saved, no key → "" (legitimately keyless — LM Studio, llama.cpp)
  //   not saved     → null (unconfigured; callers treat as no key)
  //   corrupt row   → "" (never send `enc:v1:...` as a Bearer token)
  if (isCustomProvider(provider)) {
    const cp = await getCustomProvider(provider);
    if (!cp) return null;
    if (!cp.apiKey) return "";
    return decrypt(cp.apiKey) ?? "";
  }

  // Ollama never has an API key — its config is the server URL, handled
  // by hasExplicitOllamaUrl()/getOllamaUrl(). The pre-custom signature
  // didn't even accept "ollama"; null keeps that de-facto behaviour for
  // the widened id space (and narrows `provider` to Provider below).
  if (provider === "ollama") return null;

  // Settings DB takes precedence — that's what the user pasted in the UI.
  const fromDb = await getSetting<string>(SETTING_KEY[provider]);
  if (fromDb && fromDb.length > 0) {
    const plain = decrypt(fromDb);
    // Decrypt failed — key missing or corrupt. Don't send `enc:v1:...`
    // ciphertext as the API key Bearer token. Fall through to env var.
    if (plain === null) {
      const fromEnvFallback = process.env[ENV_VAR[provider]];
      return fromEnvFallback && fromEnvFallback.length > 0
        ? fromEnvFallback
        : null;
    }
    // Lazy migration: if the row was stored plaintext, re-write encrypted
    // on first read so subsequent reads/backups carry the protected form.
    if (!isEncrypted(fromDb) && plain) {
      void setSetting(SETTING_KEY[provider], ensureEncrypted(plain)).catch(
        () => undefined,
      );
    }
    return plain;
  }

  const fromEnv = process.env[ENV_VAR[provider]];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  return null;
}

export async function getOllamaUrl(): Promise<string> {
  const fromDb = await getSetting<string>("api.ollama_url");
  if (fromDb && fromDb.length > 0) return fromDb.replace(/\/+$/, "");
  return (
    process.env.OLLAMA_URL?.replace(/\/+$/, "") ?? "http://localhost:11434"
  );
}

/**
 * Has the user actually pointed us at an Ollama server, as opposed to
 * `getOllamaUrl()` handing back its hardcoded localhost default?
 *
 * The distinction matters more than it looks. `configuredProviders()`
 * used to call `getOllamaUrl()` and test `url.length > 0` — which is
 * true unconditionally, because of that default. So Ollama counted as
 * configured on every install, `getActiveProvider()` never returned
 * null, and a brand-new user with no keys at all was told
 *
 *   "Couldn't reach ollama — check your internet connection"
 *
 * instead of "No AI provider is set up yet. Add a free Gemini or Groq
 * key in Settings → AI." It also made the no-provider branch in
 * ai-error.ts unreachable, so the one message written for exactly this
 * situation could never appear.
 */
export async function hasExplicitOllamaUrl(): Promise<boolean> {
  const fromDb = await getSetting<string>("api.ollama_url");
  if (fromDb && fromDb.trim().length > 0) return true;
  return (process.env.OLLAMA_URL ?? "").trim().length > 0;
}

/**
 * Returns the user's chosen "active" AI provider — used by every single-LLM
 * feature (exec summary, chatbot, OCR extraction). If they haven't picked one
 * explicitly, picks the first configured provider in catalog priority order.
 *
 * Returns null if literally nothing is configured.
 */
export async function getActiveProvider(): Promise<ActiveProvider | null> {
  const explicit = await getSetting<string>("ai.active_provider");
  if (explicit) {
    // Validate it's still a configured provider
    const { byId } = await configuredProviders();
    if (byId[explicit]) return explicit as ActiveProvider;
  }
  // Fall back to first configured in priority order
  const { ids } = await configuredProviders();
  return (ids[0] as ActiveProvider | undefined) ?? null;
}

/**
 * Returns the list of providers that currently have a key configured
 * (either in DB or in env). Order matches the catalog (free first).
 */
export async function configuredProviders(): Promise<{
  ids: ActiveProvider[];
  byId: Record<string, boolean>;
  customProviders: CustomProvider[];
}> {
  const { PROVIDER_CATALOG } = await import("./api-providers");
  const byId: Record<string, boolean> = {};
  const ids: ActiveProvider[] = [];

  for (const p of PROVIDER_CATALOG) {
    let configured = false;
    if (p.id === "ollama") {
      // Ollama has no API key, so "configured" means the user actually
      // gave us a server URL — NOT that getOllamaUrl() returned its
      // localhost default, which it always does. See hasExplicitOllamaUrl.
      configured = await hasExplicitOllamaUrl();
    } else {
      const k = await getApiKey(p.id as Provider);
      configured = k !== null;
    }
    byId[p.id] = configured;
    if (configured) ids.push(p.id);
  }

  // Custom user-registered providers come LAST: existence in the saved
  // list is the whole "configured" test (a keyless local endpoint is
  // fully usable), and the ids[0] fallback should still prefer a
  // curated free provider over a user experiment when both exist.
  const customs = await getCustomProviders();
  for (const c of customs) {
    byId[c.id] = true;
    ids.push(c.id);
  }
  // Full rows ride along (key material included) — callers shipping to
  // the browser MUST pass them through toPublicMeta() first (the
  // ai-providers action does). Server callers get the storage shape.
  return { ids, byId, customProviders: customs };
}

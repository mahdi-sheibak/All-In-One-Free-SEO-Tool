/**
 * Central provider registry + dispatcher.
 *
 * Every AI provider we support has the same three responsibilities:
 *   1. Resolve credentials (API key from the settings DB, or the
 *      Ollama base URL from settings).
 *   2. Format the prompt for that provider's wire protocol
 *      (OpenAI-compat, Gemini, Anthropic, or Ollama).
 *   3. Return a plain string response, or null on any failure.
 *
 * Before this file, the giant if/else in `callAI` did all three in ~130
 * lines of copy-pasted code. Any time we add a provider (e.g. Cerebras,
 * DeepSeek, Together) we had to update `callAI`, `llm-citation.ts`,
 * and `checkOneProvider` — three places, three chances to forget one
 * and ship a subtle bug.
 *
 * Now: this module owns the truth. Add a new provider entry to
 * PROVIDER_DISPATCH, and every consumer (callAI, llm-citation, future
 * multi-provider fanout tools) picks it up automatically.
 *
 * Special cases NOT covered here:
 *   - Perplexity's native citations array (kept in llm-citation for
 *     the AI visibility feature, since only that caller uses citations)
 *   - Google AI Mode + Copilot browser scrapers (different signature
 *     — they don't take an API key, they drive Playwright)
 */

import type { ActiveProvider, Provider } from "./api-keys";
import { getApiKey, getOllamaUrl } from "./api-keys";
import { defaultModelFor } from "./ai-model-presets";
import { isCustomProvider, type StaticProviderId } from "./api-providers";
import { getCustomProvider } from "./settings-store";
import { NO_KEY_STATUS, NO_OLLAMA_URL_STATUS } from "./ai-error";
import { callGemini as sharedCallGemini } from "./providers/gemini";
import { callAnthropic as sharedCallAnthropic } from "./providers/anthropic";
import { callOpenAICompat as sharedCallOpenAICompat } from "./providers/openai-compat";

/**
 * Which wire protocol a provider speaks. Determines which shared
 * caller (callGemini / callAnthropic / callOpenAICompat / direct Ollama
 * fetch) handles the request.
 */
export type ProviderKind = "openai-compat" | "gemini" | "anthropic" | "ollama";

export type ProviderSpec = {
  id: ActiveProvider;
  kind: ProviderKind;
  /** Chat-completions endpoint. Required for openai-compat providers. */
  endpoint?: string;
  /** Extra request headers. OpenRouter uses this for the required x-title. */
  extraHeaders?: Record<string, string>;
  /**
   * Custom providers only: the stored free-text model id. Lets dispatch
   * send the right model even when the runtime metadata seed in
   * ai-model-presets was never populated (long-running workers, tests).
   */
  model?: string;
  /**
   * Custom providers only: the already-resolved API key. "" means a
   * keyless local endpoint (LM Studio, llama.cpp) — legitimate, and
   * openai-compat omits the Bearer header entirely for those.
   */
  apiKey?: string;
  /** True when this spec came from the ai.custom_providers settings row. */
  custom?: boolean;
};

/**
 * Resolve the wire-spec for ANY dispatchable provider id — built-ins
 * from the static table above, user-registered custom providers
 * (`custom:<slug>`) from the `ai.custom_providers` settings row.
 *
 * Custom specs carry their stored `model` too, so dispatch stays
 * self-sufficient even when the runtime metadata seed in
 * ai-model-presets was never populated (long-running workers, tests).
 * Returns null for unknown/unsaved ids — callers treat that as
 * "not configured", never as a hard error.
 */
export async function resolveProviderSpec(
  providerId: ActiveProvider,
): Promise<ProviderSpec | null> {
  if (!isCustomProvider(providerId)) {
    return PROVIDER_DISPATCH[providerId] ?? null;
  }
  const cp = await getCustomProvider(providerId);
  if (!cp) return null;
  // getApiKey already covers every key state for customs: saved with a
  // stored key → decrypted, keyless → "" (unsaved ids never reach this
  // line because cp exists). A plain const keeps no await inside a
  // member initializer.
  const apiKey = (await getApiKey(providerId)) ?? "";
  return {
    id: cp.id,
    kind: "openai-compat",
    endpoint: `${cp.baseUrl}/chat/completions`,
    // Free-text model from the settings row — a custom spec with no
    // model would send `model: ""`, which every gateway 400s on.
    model: cp.model,
    apiKey,
    custom: true,
  };
}

export const PROVIDER_DISPATCH: Record<StaticProviderId, ProviderSpec> = {
  gemini: {
    id: "gemini",
    kind: "gemini",
  },
  groq: {
    id: "groq",
    kind: "openai-compat",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
  },
  anthropic: {
    id: "anthropic",
    kind: "anthropic",
  },
  openai: {
    id: "openai",
    kind: "openai-compat",
    endpoint: "https://api.openai.com/v1/chat/completions",
  },
  openrouter: {
    id: "openrouter",
    kind: "openai-compat",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    extraHeaders: { "x-title": "SEO Tool" },
  },
  perplexity: {
    id: "perplexity",
    kind: "openai-compat",
    endpoint: "https://api.perplexity.ai/chat/completions",
  },
  ollama: {
    id: "ollama",
    kind: "ollama",
  },
  mistral: {
    id: "mistral",
    kind: "openai-compat",
    endpoint: "https://api.mistral.ai/v1/chat/completions",
  },
  deepseek: {
    id: "deepseek",
    kind: "openai-compat",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
  },
  cerebras: {
    id: "cerebras",
    kind: "openai-compat",
    endpoint: "https://api.cerebras.ai/v1/chat/completions",
  },
  together: {
    id: "together",
    kind: "openai-compat",
    endpoint: "https://api.together.xyz/v1/chat/completions",
  },
  github: {
    id: "github",
    kind: "openai-compat",
    endpoint: "https://models.inference.ai.azure.com/chat/completions",
  },
};

export type DispatchArgs = {
  system: string;
  user: string;
  model?: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  /** For logging / error attribution. Passed through to the shared callers. */
  caller?: string;
  /**
   * Multi-turn conversation history (assistant chat). When present,
   * the message-capable branches send history INSTEAD OF the lone
   * `user` turn — `user` still names the final user message for the
   * branches that stay single-turn (Ollama's direct helper). Roles
   * map 1:1 onto every shared caller's message type, so the assistant
   * forwards its transcript verbatim.
   */
  history?: { role: "user" | "assistant"; content: string }[];
  /**
   * Receives the provider's status + body when a call fails, so the
   * caller can tell the user WHY rather than rendering an empty box.
   * See ai-error.ts for how these become user-facing sentences.
   */
  onFailure?: (status: number, body: string) => void;
};

/**
 * The single entry point every AI call goes through. Given a provider
 * id + prompt args, resolves the API key (or Ollama URL), picks the
 * right wire-protocol caller, and returns the model's response.
 *
 * Returns null on:
 *   - Provider not in the registry
 *   - No API key configured (for key-based providers)
 *   - No Ollama URL configured (for the ollama provider)
 *   - Underlying transport / parsing failure
 *
 * Never throws — every shared caller catches internally and returns null.
 */
export async function dispatchProviderCall(
  providerId: ActiveProvider,
  args: DispatchArgs,
): Promise<string | null> {
  // Custom providers resolve DYNAMICALLY from the settings row — the
  // static table only knows the 12 built-ins.
  const spec = await resolveProviderSpec(providerId);
  if (!spec) return null;

  // Precedence: per-call override → the custom spec's stored model →
  // the catalog default ("" for customs with no stored model yet —
  // the model picker persists one on first use).
  const model = args.model?.trim() || spec.model || defaultModelFor(providerId);
  const caller = args.caller ?? "provider-dispatch";
  // Multi-turn transcript when a caller (assistant chat) supplies one;
  // every other caller keeps the lone user turn. The neutral
  // {role, content} shape is structurally assignable to all three
  // shared callers' message unions (their text-member is exactly this).
  const transcript: { role: "user" | "assistant"; content: string }[] =
    args.history ?? [{ role: "user", content: args.user }];

  switch (spec.kind) {
    case "gemini": {
      const apiKey = await getApiKey(providerId as Provider);
      if (!apiKey) {
        args.onFailure?.(NO_KEY_STATUS, "no api key configured");
        return null;
      }
      return sharedCallGemini({
        apiKey,
        model,
        system: args.system,
        messages: transcript,
        maxTokens: args.maxTokens,
        temperature: args.temperature,
        timeoutMs: args.timeoutMs,
        caller,
        onFailure: args.onFailure,
      });
    }
    case "anthropic": {
      const apiKey = await getApiKey(providerId as Provider);
      if (!apiKey) {
        args.onFailure?.(NO_KEY_STATUS, "no api key configured");
        return null;
      }
      return sharedCallAnthropic({
        apiKey,
        model,
        system: args.system,
        messages: transcript,
        maxTokens: args.maxTokens,
        temperature: args.temperature,
        timeoutMs: args.timeoutMs,
        caller,
        onFailure: args.onFailure,
      });
    }
    case "openai-compat": {
      if (!spec.endpoint) return null;
      // CUSTOM PROVIDERS: the spec already carries endpoint + model +
      // (possibly empty) key from the settings row — resolveProviderSpec
      // fetched and decrypted everything in one read. Keyless local
      // endpoints (LM Studio, llama.cpp, keyless vLLM) are legitimate:
      // only catalog providers require a key (NO_KEY sentinel below).
      if (spec.custom) {
        return sharedCallOpenAICompat({
          endpoint: spec.endpoint,
          // "" key = keyless endpoint — openai-compat omits the
          // Bearer header entirely for those.
          apiKey: spec.apiKey ?? "",
          model,
          system: args.system,
          messages: transcript,
          maxTokens: args.maxTokens,
          temperature: args.temperature,
          timeoutMs: args.timeoutMs,
          caller,
          onFailure: args.onFailure,
        });
      }
      const apiKey = await getApiKey(providerId as Provider);
      if (!apiKey) {
        args.onFailure?.(NO_KEY_STATUS, "no api key configured");
        return null;
      }
      return sharedCallOpenAICompat({
        endpoint: spec.endpoint,
        apiKey,
        model,
        system: args.system,
        messages: transcript,
        maxTokens: args.maxTokens,
        temperature: args.temperature,
        timeoutMs: args.timeoutMs,
        extraHeaders: spec.extraHeaders,
        caller,
        onFailure: args.onFailure,
      });
    }
    case "ollama": {
      const url = await getOllamaUrl();
      // Guard: an empty Ollama URL would fetch `null/api/chat` and throw
      // inside the outer catch, giving the caller a mystery null with
      // no hint about what to configure.
      if (!url) {
        args.onFailure?.(NO_OLLAMA_URL_STATUS, "no ollama url configured");
        return null;
      }
      return callOllamaDirect({
        url,
        model,
        system: args.system,
        user: args.user,
        maxTokens: args.maxTokens,
        temperature: args.temperature,
        timeoutMs: args.timeoutMs,
        onFailure: args.onFailure,
      });
    }
  }
}

/**
 * Ollama's HTTP surface differs enough from OpenAI-compat that it's not
 * worth shoehorning through the shared caller — no auth header, message
 * role handling differs slightly, and its response shape is
 * `{ message: { content } }` at the top level (not nested in choices).
 */
async function callOllamaDirect(args: {
  url: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  onFailure?: (status: number, body: string) => void;
}): Promise<string | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), args.timeoutMs);
  try {
    const res = await fetch(`${args.url}/api/chat`, {
      method: "POST",
      signal: c.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: args.model || "llama3.2",
        stream: false,
        options: {
          temperature: args.temperature,
          num_predict: args.maxTokens,
        },
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
      }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 240);
      args.onFailure?.(res.status, body || res.statusText);
      return null;
    }
    const data = (await res.json()) as {
      message?: { content?: string };
    };
    return data.message?.content?.trim() ?? null;
  } catch (err) {
    args.onFailure?.(0, (err as Error).message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Default model for ANY dispatchable provider: the catalog default for
 * built-ins, the stored free-text model for customs ("" when none has
 * been saved yet — dispatch falls back and the model picker persists
 * one on first use). Use this instead of defaultModelFor anywhere the
 * provider id can be custom. As a side effect it seeds the runtime
 * metadata cache via getCustomProvider, so providerLabel() renders the
 * human label afterwards.
 */
export async function resolveDefaultModel(
  providerId: ActiveProvider,
): Promise<string> {
  if (isCustomProvider(providerId)) {
    const cp = await getCustomProvider(providerId);
    return cp?.model ?? "";
  }
  return defaultModelFor(providerId);
}

/**
 * Convenience: look up the default model for a provider. Callers that
 * want to log "which model actually ran" can use this before dispatch.
 *
 * Re-exported from ai-model-presets so the model the picker labels
 * "default" is byte-for-byte the model dispatch sends when no override
 * is set. These used to be two separate literals and drifted — the
 * picker offered retired Gemini 1.5 ids while dispatch sent 2.0.
 */
export { defaultModelFor } from "./ai-model-presets";

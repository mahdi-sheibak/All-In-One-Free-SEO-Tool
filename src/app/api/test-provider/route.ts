/**
 * Test-provider endpoint — runs a tiny real call against the named
 * provider and reports the actual error from whichever stage failed:
 *
 *   1. No key saved at all
 *   2. Key saved but API rejects it (4xx)
 *   3. Network / timeout
 *   4. Wrong model name
 *
 * Critical: bypasses the generic callAI() because that silently returns
 * null on all of the above. We want explicit error messages.
 */

import { getApiKey, getOllamaUrl } from "@/lib/api-keys";
import {
  MODEL_PRESETS,
  defaultModelFor,
  providerLabel,
} from "@/lib/ai-model-presets";
import { isCustomProvider } from "@/lib/api-providers";
import { resolveProviderSpec } from "@/lib/provider-dispatch";
import type { ActiveProvider } from "@/lib/api-keys";
import { checkRateLimit, clientKey } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID: ReadonlySet<ActiveProvider> = new Set([
  "openai",
  "anthropic",
  "gemini",
  "perplexity",
  "openrouter",
  "groq",
  "mistral",
  "deepseek",
  "cerebras",
  "together",
  "github",
  "ollama",
]);

type ProbeResult =
  | { ok: true; reply: string }
  | { ok: false; status?: number; error: string };

async function probeGemini(apiKey: string): Promise<ProbeResult> {
  // Current free-tier model names, newest first. We try in order and
  // return on the first 200. gemini-pro is intentionally NOT here — it
  // was removed from the v1beta endpoint and only causes confusion.
  // Drawn from the shared preset table so this probe can't drift from
  // the models the app actually uses. The old hardcoded list still
  // carried the Gemini 1.5 ids Google retired in Sept 2025 — the
  // "Test connection" button burned two guaranteed 404s before finding
  // a live model, and reported failure outright if the live ones were
  // momentarily rate-limited.
  const candidates = MODEL_PRESETS.gemini.map((p) => p.id);
  const attempts: string[] = [];
  let authError: { status: number; body: string } | null = null;

  for (const model of candidates) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Say: Connected." }] }],
          generationConfig: { maxOutputTokens: 30, temperature: 0 },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const reply =
          data.candidates?.[0]?.content?.parts
            ?.map((p) => p.text ?? "")
            .join("")
            .trim() ?? "";
        return {
          ok: true,
          reply: `[${model}] ${reply || "(empty reply but key works)"}`,
        };
      }
      const body = (await res.text()).slice(0, 200);
      attempts.push(`${model}=${res.status}`);
      // Auth-level errors mean the KEY is bad — stop trying other models.
      if (res.status === 401 || res.status === 403) {
        authError = { status: res.status, body };
        break;
      }
      // 400 from v1beta with API_KEY_INVALID is also key-level, not model
      if (
        res.status === 400 &&
        /API_KEY_INVALID|API key not valid/i.test(body)
      ) {
        authError = { status: 400, body };
        break;
      }
    } catch (err) {
      attempts.push(`${model}=${(err as Error).message.slice(0, 40)}`);
    }
  }

  if (authError) {
    return {
      ok: false,
      status: authError.status,
      error: `Key rejected (${authError.status}). ${authError.body.replace(/\s+/g, " ").slice(0, 180)}. Generate a fresh key at https://aistudio.google.com/apikey`,
    };
  }
  return {
    ok: false,
    error: `None of the current Gemini models work with this key. Tried: ${attempts.join(", ")}. The key looks valid (no auth error) but lacks access. Most likely fix: open https://aistudio.google.com/apikey → delete the key → create a new one.`,
  };
}

async function probeOpenAICompat(opts: {
  endpoint: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
}): Promise<ProbeResult> {
  try {
    // Scheme re-check at the fetch site (defense in depth): the save
    // action already enforces http(s) via normalizeBaseUrl, but this
    // URL lives in a settings row — a hand-edited DB or a future
    // writer bypassing normalizeBaseUrl must not turn the probe into
    // a non-http fetch. No host allowlist by design: custom endpoints
    // are admin-supplied config in a single-user local-first app
    // (see custom-providers.ts "SSRF stance"), same trust class as
    // the Ollama URL.
    const scheme = new URL(opts.endpoint).protocol;
    if (scheme !== "http:" && scheme !== "https:") {
      return { ok: false, error: `Endpoint must be http(s), got "${scheme}".` };
    }
    const res = await fetch(opts.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Same contract as providers/openai-compat.ts: keyless local
        // endpoints must not receive an empty `Bearer ` header.
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        ...(opts.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: "user", content: "Say: Connected." }],
        max_tokens: 30,
        temperature: 0,
        // Some OpenAI-compatible servers (a few llama.cpp / custom
        // gateway builds) stream by default when `stream` is omitted,
        // answering 200 + `data: {...}` lines that res.json() can't
        // parse. Pin it off — the probe expects a single JSON object.
        stream: false,
      }),
      // 30s, not 15s: real AI calls via ai-call.ts allow 60s, and
      // self-hosted / free-tier gateways (Ollama cold model loads,
      // proxy routers queueing upstream models) routinely exceed 15s
      // on a cold request while staying well under 60s. A probe that
      // times out while real calls would succeed is a false negative
      // that blocks configuring a perfectly usable provider.
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { ok: false, status: res.status, error: body };
    }
    // Read the body as text, then parse. Two reasons: (1) a server
    // that ignored stream:false answers 200 with SSE `data:` lines or
    // concatenated JSON objects, and the raw V8 message ("Unexpected
    // non-whitespace character after JSON at position N") told the
    // user nothing about their endpoint; (2) on that exact failure we
    // can now show a slice of what actually came back, so "my gateway
    // streams by default" is diagnosable from the error text alone.
    const raw = await res.text();
    let data: { choices?: { message?: { content?: string } }[] };
    try {
      data = JSON.parse(raw);
    } catch {
      const head = raw.trim().slice(0, 200);
      const streamed = head.startsWith("data:") || /\ndata:/.test(head);
      return {
        ok: false,
        error: streamed
          ? `Endpoint replied 200 with a streaming body (SSE "data:" lines), not JSON. This gateway streams by default — enable a non-streaming mode or a compliant gateway, or point the base URL at the server's non-streaming route.`
          : `Endpoint replied 200 with a non-JSON body. First 200 chars: ${head}`,
      };
    }
    const reply = data.choices?.[0]?.message?.content?.trim() ?? "";
    return { ok: true, reply: reply || "(empty reply but key works)" };
  } catch (err) {
    // AbortSignal.timeout aborts with a DOMException named
    // "TimeoutError"; surface it as guidance instead of V8's bare
    // "The operation was aborted due to timeout", which reads like a
    // client bug rather than "your endpoint was too slow".
    if ((err as Error)?.name === "TimeoutError") {
      return {
        ok: false,
        error:
          "No reply within 30s — the endpoint is too slow or unreachable right now. Free/proxy routers often spike on cold requests; try Test again, and note real AI calls allow up to 60s.",
      };
    }
    return { ok: false, error: (err as Error).message };
  }
}

async function probeAnthropic(apiKey: string): Promise<ProbeResult> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: defaultModelFor("anthropic"),
        max_tokens: 30,
        messages: [{ role: "user", content: "Say: Connected." }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { ok: false, status: res.status, error: body };
    }
    const data = (await res.json()) as { content?: { text?: string }[] };
    const reply =
      data.content
        ?.map((c) => c.text ?? "")
        .join("")
        .trim() ?? "";
    return { ok: true, reply: reply || "(empty reply but key works)" };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function probeOllama(url: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `Ollama at ${url} returned ${res.status}. Is the daemon running?`,
      };
    }
    const data = (await res.json()) as { models?: { name?: string }[] };
    const count = data.models?.length ?? 0;
    return {
      ok: true,
      reply: `Ollama reachable. ${count} model${count === 1 ? "" : "s"} installed.`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't reach Ollama at ${url}: ${(err as Error).message}. Is it running?`,
    };
  }
}

export async function POST(req: Request) {
  // Rate limit: every probe hits a real upstream provider API and may
  // count toward the user's quota. 12 tests per minute per IP is plenty
  // for legitimate use (clicking Test once per provider you're trying)
  // and prevents accidental thrashing.
  const limit = checkRateLimit(`test-provider:${clientKey(req)}`, {
    max: 12,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    return Response.json(
      {
        ok: false,
        error: `Rate limit hit (12 tests / minute). Wait ${Math.ceil((limit.resetAt - Date.now()) / 1000)}s and try again.`,
      },
      { status: 429, headers: { "retry-after": "30" } },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    provider?: string;
  } | null;
  const provider = body?.provider as ActiveProvider | undefined;

  // Customs aren't in the static set but are probeable once saved.
  if (!provider || !(VALID.has(provider) || isCustomProvider(provider))) {
    return Response.json(
      { ok: false, error: "Invalid provider" },
      { status: 400 },
    );
  }

  const startedAt = Date.now();
  let result: ProbeResult;

  if (provider === "ollama") {
    const url = await getOllamaUrl();
    if (!url) {
      result = {
        ok: false,
        error: "Ollama URL not set. Save the Ollama URL above first.",
      };
    } else {
      result = await probeOllama(url);
    }
  } else if (isCustomProvider(provider)) {
    // Probe through the SAME resolver dispatch uses — endpoint, model
    // and key all come from the saved ai.custom_providers row, so this
    // button tests exactly what real calls will do. No hardcoded
    // endpoint here; an unsaved id resolves to null.
    const spec = await resolveProviderSpec(provider);
    if (!spec || spec.kind !== "openai-compat" || !spec.endpoint) {
      result = {
        ok: false,
        error: `Custom provider "${providerLabel(provider)}" is not saved (or was deleted). Re-add it below, then test.`,
      };
    } else if (!spec.model) {
      result = {
        ok: false,
        error: `No model set for "${providerLabel(provider)}". Type a model name in the AI model picker and press Save, then test.`,
      };
    } else {
      result = await probeOpenAICompat({
        endpoint: spec.endpoint,
        apiKey: spec.apiKey ?? "",
        model: spec.model,
      });
    }
  } else {
    const key = await getApiKey(provider);
    if (!key) {
      result = {
        ok: false,
        error: `No key saved for ${provider}. Paste a key in the field above + click Save, then click Test.`,
      };
    } else if (provider === "gemini") {
      result = await probeGemini(key);
    } else if (provider === "anthropic") {
      result = await probeAnthropic(key);
    } else if (provider === "groq") {
      result = await probeOpenAICompat({
        endpoint: "https://api.groq.com/openai/v1/chat/completions",
        apiKey: key,
        model: "llama-3.3-70b-versatile",
      });
    } else if (provider === "openai") {
      result = await probeOpenAICompat({
        endpoint: "https://api.openai.com/v1/chat/completions",
        apiKey: key,
        model: "gpt-4o-mini",
      });
    } else if (provider === "openrouter") {
      result = await probeOpenAICompat({
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        apiKey: key,
        model: "meta-llama/llama-3.3-70b-instruct:free",
        extraHeaders: { "x-title": "SEO Tool" },
      });
    } else if (provider === "perplexity") {
      result = await probeOpenAICompat({
        endpoint: "https://api.perplexity.ai/chat/completions",
        apiKey: key,
        model: "sonar",
      });
    } else if (provider === "mistral") {
      result = await probeOpenAICompat({
        endpoint: "https://api.mistral.ai/v1/chat/completions",
        apiKey: key,
        model: "mistral-large-latest",
      });
    } else if (provider === "deepseek") {
      result = await probeOpenAICompat({
        endpoint: "https://api.deepseek.com/v1/chat/completions",
        apiKey: key,
        model: "deepseek-chat",
      });
    } else if (provider === "cerebras") {
      result = await probeOpenAICompat({
        endpoint: "https://api.cerebras.ai/v1/chat/completions",
        apiKey: key,
        model: "llama-3.3-70b",
      });
    } else if (provider === "together") {
      result = await probeOpenAICompat({
        endpoint: "https://api.together.xyz/v1/chat/completions",
        apiKey: key,
        model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      });
    } else if (provider === "github") {
      result = await probeOpenAICompat({
        endpoint: "https://models.inference.ai.azure.com/chat/completions",
        apiKey: key,
        model: "gpt-4o",
      });
    } else {
      result = { ok: false, error: `Unknown provider: ${provider}` };
    }
  }

  const elapsedMs = Date.now() - startedAt;

  if (result.ok) {
    return Response.json({
      ok: true,
      provider,
      reply: result.reply.slice(0, 200),
      elapsedMs,
    });
  }

  return Response.json(
    {
      ok: false,
      provider,
      status: result.status,
      error: result.error,
      elapsedMs,
    },
    { status: 200 },
  );
}

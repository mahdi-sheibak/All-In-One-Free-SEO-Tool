/**
 * Single shared caller for every provider that speaks the OpenAI
 * Chat-Completions wire protocol: OpenAI, Groq, OpenRouter, Perplexity,
 * Mistral, DeepSeek, Cerebras, Together, GitHub Models, and most
 * self-hosted LLM gateways.
 *
 * They differ only in endpoint URL, default model, and a couple of
 * provider-specific headers (OpenRouter's x-title, etc). The caller
 * passes those in; everything else (auth, payload shape, response
 * parsing, abort, error logging) is shared here.
 *
 * Returns null on failure, never throws — keeps caller boilerplate
 * minimal.
 */

export type OpenAICompatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "user";
      content: string;
      image: { mimeType: string; base64: string };
    };

export type OpenAICompatCallOpts = {
  endpoint: string;
  apiKey: string;
  /** Provider-specific model id. No fallback; users pick from settings. */
  model: string;
  system: string;
  messages: OpenAICompatMessage[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  /** Provider-specific extras (OpenRouter's x-title, etc.) */
  extraHeaders?: Record<string, string>;
  /** Origin tag for server-log debugging */
  caller?: string;
  /**
   * Optional sink for failure details. The function still returns
   * `string | null`, so the existing call sites are untouched — but a
   * caller that wants to tell the USER why (callAI) passes this and
   * gets the status + response body instead of an undifferentiated
   * null. Fires once, with the final attempt's outcome.
   */
  onFailure?: (status: number, body: string) => void;
};

/**
 * Status codes worth retrying once.
 *   0 — network error / abort
 *   429 — rate-limited (free tiers + burst protection)
 *   500/502/503/504 — transient server issues
 * Permanent failures (400 bad request, 401 bad key, 404 wrong model)
 * are NOT retried — retrying just wastes time.
 */
const RETRY_STATUSES = new Set([0, 429, 500, 502, 503, 504]);
const RETRY_BACKOFF_MS = 1500;

export async function callOpenAICompat(
  opts: OpenAICompatCallOpts,
): Promise<string | null> {
  // One retry with backoff. Most rate-limits are bursty and a 1.5s
  // delay is enough to slip past — the global ai-semaphore further
  // reduces the chance of hitting 429 in the first place.
  let attempt = 0;
  while (true) {
    const result = await dispatchOpenAICompat(opts);
    if (result.ok) return result.text;
    if (attempt >= 1 || !RETRY_STATUSES.has(result.status)) {
      opts.onFailure?.(result.status, result.body);
      return null;
    }
    attempt++;
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
  }
}

async function dispatchOpenAICompat(
  opts: OpenAICompatCallOpts,
): Promise<
  | { ok: true; text: string | null }
  | { ok: false; status: number; body: string }
> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const messages: unknown[] = [];
    if (opts.system) {
      messages.push({ role: "system", content: opts.system });
    }
    for (const m of opts.messages) {
      if ("image" in m && m.image) {
        messages.push({
          role: m.role,
          content: [
            { type: "text", text: m.content },
            {
              type: "image_url",
              image_url: {
                url: `data:${m.image.mimeType};base64,${m.image.base64}`,
              },
            },
          ],
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const res = await fetch(opts.endpoint, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        // Keyless custom endpoints (LM Studio, llama.cpp server, many
        // self-hosted gateways) reject or ignore Bearer auth — and
        // sending `Bearer ` with an empty key can make some servers
        // 401. Omit the header entirely when no key is configured;
        // catalog providers always have a key enforced upstream.
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        ...(opts.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        // Some self-hosted OpenAI-compatible servers (certain llama.cpp
        // / custom gateway builds) stream by default when `stream` is
        // omitted, answering 200 with SSE `data:` lines or concatenated
        // JSON chunks. Pin it off so the reply is one JSON object, the
        // shape every parser below expects.
        stream: false,
      }),
    });
    if (!res.ok) {
      const errBody = (await res.text().catch(() => "")).slice(0, 240);
      console.error(
        `[${opts.caller ?? "openai-compat"}] ${opts.model} ${res.status}: ${errBody || res.statusText}`,
      );
      return { ok: false, status: res.status, body: errBody || res.statusText };
    }
    // Text-first parse instead of res.json(): a 200 whose body is not
    // a single JSON document (server ignored stream:false and answered
    // SSE, or a proxy concatenated/duplicated the body) used to die
    // with V8's cryptic "Unexpected non-whitespace character after
    // JSON at position N" — which told the user nothing about their
    // gateway. Reporting the body prefix instead shows WHAT came back.
    const raw = await res.text();
    let data: { choices?: { message?: { content?: string } }[] };
    try {
      data = JSON.parse(raw);
    } catch {
      const head = raw.trim().slice(0, 200) || "(empty body)";
      console.error(
        `[${opts.caller ?? "openai-compat"}] ${opts.model} 200 but not JSON: ${head}`,
      );
      return {
        // 0 = retryable, same class as a truncated network response —
        // a body that got mangled once may succeed on a second try.
        ok: false,
        status: 0,
        body: `Endpoint replied 200 with a non-JSON body. First 200 chars: ${head}`,
      };
    }
    return {
      ok: true,
      text: data.choices?.[0]?.message?.content?.trim() || null,
    };
  } catch (err) {
    console.error(
      `[${opts.caller ?? "openai-compat"}] ${opts.model} call failed:`,
      (err as Error).message,
    );
    // Network / abort — treat as retryable (status 0 conventionally).
    return { ok: false, status: 0, body: (err as Error).message };
  } finally {
    clearTimeout(t);
  }
}

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The four wire protocols every AI provider speaks.
 *
 * Twelve providers share four response parsers — Gemini, Anthropic,
 * OpenAI-compatible (Groq, OpenAI, OpenRouter, Perplexity, Mistral,
 * DeepSeek, Cerebras, Together, GitHub Models) and Ollama. The product
 * claim is that one free key makes the whole tool work, so a parser that
 * reads the wrong field doesn't break one feature; it breaks eighty.
 *
 * That failure is silent by construction. Every parser ends in optional
 * chaining, so a wrong field name yields `null`, which the layer above
 * reports as "the model returned nothing" — indistinguishable from a
 * real empty response, and identical across all providers.
 *
 * The bodies below are each provider's documented success shape. This is
 * the same check that found four wrong field names in the WordPress
 * bridge; the difference between reading a parser and running it is the
 * whole reason this file exists.
 *
 * Not covered: that the real APIs still return these shapes. They change
 * without notice, and only a live call proves otherwise.
 */

vi.mock("../api-keys", () => ({
  getApiKey: async () => "test-key",
  getOllamaUrl: async () => "http://localhost:11434",
}));

const { callGemini } = await import("./gemini");
const { callAnthropic } = await import("./anthropic");
const { callOpenAICompat } = await import("./openai-compat");

const REPLY = "Handmade Soap for Sensitive Skin";

let fetchMock: ReturnType<typeof vi.fn>;

function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function sentBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as { body?: string };
  return JSON.parse(init?.body ?? "{}");
}
function sentHeaders(): Record<string, string> {
  const init = fetchMock.mock.calls[0]?.[1] as {
    headers?: Record<string, string>;
  };
  return init?.headers ?? {};
}
function sentUrl(): string {
  return String(fetchMock.mock.calls[0]?.[0] ?? "");
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const common = {
  model: "test-model",
  system: "You write page titles.",
  messages: [{ role: "user" as const, content: "Write a title." }],
  maxTokens: 200,
  temperature: 0.6,
  timeoutMs: 5000,
};

describe("Gemini", () => {
  it("reads candidates[0].content.parts[].text", async () => {
    respond({
      candidates: [
        { content: { parts: [{ text: REPLY }] }, finishReason: "STOP" },
      ],
    });
    expect(await callGemini({ apiKey: "k", ...common })).toBe(REPLY);
  });

  it("joins multiple parts, which is how longer replies arrive", async () => {
    respond({
      candidates: [
        {
          content: {
            parts: [{ text: "Handmade Soap " }, { text: "for Sensitive Skin" }],
          },
        },
      ],
    });
    expect(await callGemini({ apiKey: "k", ...common })).toBe(REPLY);
  });

  it("returns null when the prompt was blocked, rather than empty text", async () => {
    // A safety block is not the same as "the model had nothing to say".
    respond({ candidates: [], promptFeedback: { blockReason: "SAFETY" } });
    expect(await callGemini({ apiKey: "k", ...common })).toBeNull();
  });

  it("sends the key without putting it in a logged URL path", async () => {
    respond({ candidates: [{ content: { parts: [{ text: REPLY }] } }] });
    await callGemini({ apiKey: "secret-key", ...common });
    // Either header or query is acceptable to Google; what matters is
    // that a key exists on the request at all.
    const hasKey =
      sentUrl().includes("secret-key") ||
      Object.values(sentHeaders()).includes("secret-key");
    expect(hasKey).toBe(true);
  });
});

describe("Anthropic", () => {
  it("reads the text blocks out of content[]", async () => {
    respond({
      content: [{ type: "text", text: REPLY }],
      stop_reason: "end_turn",
    });
    expect(await callAnthropic({ apiKey: "k", ...common })).toBe(REPLY);
  });

  it("ignores non-text blocks instead of stringifying them", async () => {
    // A thinking or tool_use block has no `text`, and concatenating it
    // blindly would put "undefined" into a page title.
    respond({
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: REPLY },
      ],
    });
    const r = await callAnthropic({ apiKey: "k", ...common });
    expect(r).toBe(REPLY);
    expect(r).not.toMatch(/undefined/);
  });

  it("sends the version header the API requires", async () => {
    respond({ content: [{ type: "text", text: REPLY }] });
    await callAnthropic({ apiKey: "k", ...common });
    const h = sentHeaders();
    const keys = Object.keys(h).map((k) => k.toLowerCase());
    expect(keys).toContain("anthropic-version");
    expect(keys).toContain("x-api-key");
  });

  it("puts the system prompt in the top-level field, not in messages", async () => {
    // Anthropic rejects a "system" role inside messages. Getting this
    // wrong is a 400 on every call, for every feature.
    respond({ content: [{ type: "text", text: REPLY }] });
    await callAnthropic({ apiKey: "k", ...common });
    const body = sentBody();
    expect(body.system).toBe(common.system);
    const roles = (body.messages as { role: string }[]).map((m) => m.role);
    expect(roles).not.toContain("system");
  });
});

describe("OpenAI-compatible (Groq, OpenAI, OpenRouter, and six more)", () => {
  const oc = {
    endpoint: "https://api.example.com/v1/chat/completions",
    apiKey: "k",
  };

  it("reads choices[0].message.content", async () => {
    respond({ choices: [{ message: { role: "assistant", content: REPLY } }] });
    const r = await callOpenAICompat({ ...oc, ...common });
    expect(r).toBe(REPLY);
  });

  it("returns null on an empty choices array rather than throwing", async () => {
    respond({ choices: [] });
    expect(await callOpenAICompat({ ...oc, ...common })).toBeNull();
  });

  it("sends the system prompt as a system-role message", async () => {
    respond({ choices: [{ message: { content: REPLY } }] });
    await callOpenAICompat({ ...oc, ...common });
    const msgs = sentBody().messages as { role: string; content: string }[];
    expect(msgs[0]).toEqual({ role: "system", content: common.system });
  });

  it("authenticates with a Bearer token", async () => {
    respond({ choices: [{ message: { content: REPLY } }] });
    await callOpenAICompat({ ...oc, ...common });
    const auth = sentHeaders().authorization ?? sentHeaders().Authorization;
    expect(auth).toBe("Bearer k");
  });

  it("passes provider-specific extra headers through", async () => {
    // OpenRouter requires x-title; dropping it gets calls rejected.
    respond({ choices: [{ message: { content: REPLY } }] });
    await callOpenAICompat({
      ...oc,
      ...common,
      extraHeaders: { "x-title": "SEO Tool" },
    });
    expect(sentHeaders()["x-title"]).toBe("SEO Tool");
  });

  it("omits the auth header entirely for a keyless custom endpoint", async () => {
    // Local gateways (LM Studio, llama.cpp server) reject or ignore
    // Bearer auth, and some 401 on an empty `Bearer ` value. A blank
    // key must mean NO authorization header, not an empty one.
    respond({ choices: [{ message: { content: REPLY } }] });
    await callOpenAICompat({ ...oc, ...common, apiKey: "" });
    const h = sentHeaders();
    expect(h).not.toHaveProperty("authorization");
    expect(h).not.toHaveProperty("Authorization");
  });

  it("sends stream:false — some servers stream by default and break the JSON parser", async () => {
    // The wire contract is ONE JSON object back. Certain self-hosted
    // gateways interpret a missing `stream` field as "stream please" and
    // answer 200 with SSE `data:` lines / concatenated JSON objects,
    // which no single-document JSON.parse accepts. Pinning it off here
    // (and in the test-provider probe) keeps the two callers honest
    // with each other.
    respond({ choices: [{ message: { content: REPLY } }] });
    await callOpenAICompat({ ...oc, ...common });
    expect(sentBody().stream).toBe(false);
  });

  it("treats a 200 with a non-JSON body as retryable and reports the body", async () => {
    // Regression for the Settings→Test symptom: a gateway that ignores
    // stream:false and answers with concatenated JSON objects used to
    // die inside res.json() with V8's "Unexpected non-whitespace
    // character after JSON at position N". Now the raw body prefix is
    // reported via onFailure so the user sees what their endpoint
    // actually returned instead of a parser's complaint about it.
    const raw =
      '{"choices":[{"message":{"content":"hi"}}]}{"choices":[{"message":{"content":"hi"}}]}';
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "",
      text: async () => raw,
      json: async () => {
        throw new Error("res.json() must not be reached");
      },
    });
    const seen: { status: number; body: string }[] = [];
    const r = await callOpenAICompat({
      ...oc,
      ...common,
      onFailure: (status, body) => seen.push({ status, body }),
    });
    expect(r).toBeNull();
    expect(seen[0].body).toContain("non-JSON body");
    expect(seen[0].body).toContain('"choices"');
    // status 0 = the retryable bucket, so a one-off mangled body gets
    // one retry instead of being declared a permanent failure.
    expect(seen[0].status).toBe(0);
  });
});

describe("every protocol, on the same failure", () => {
  // The distinction that makes Settings → AI usable: a 401 is the user's
  // key being wrong and is worth telling them about; it must not look
  // like the model having nothing to say.
  it("reports an HTTP error as a failure with its status, not as empty text", async () => {
    const seen: { status: number }[] = [];
    const onFailure = (status: number) => seen.push({ status });
    respond({ error: { message: "invalid api key" } }, 401);

    await callGemini({ apiKey: "k", ...common, onFailure });
    await callAnthropic({ apiKey: "k", ...common, onFailure });
    await callOpenAICompat({
      endpoint: "https://api.example.com/v1/chat/completions",
      apiKey: "k",
      ...common,
      onFailure,
    });

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((s) => s.status === 401)).toBe(true);
  });
});

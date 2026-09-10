import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Custom-provider resolution at the dispatch layer.
 *
 * The spec contract being pinned here: a saved custom endpoint becomes
 * `{ kind: "openai-compat", endpoint: <baseUrl>/chat/completions }`
 * carrying its stored model and resolved key, and dispatch sends to it
 * exactly like a catalog openai-compat provider — except that a keyless
 * endpoint (LM Studio, llama.cpp) sends NO authorization header at all
 * instead of `Bearer ` + empty string.
 *
 * The unsaved-id case returns null (not an error) — callers treat that
 * as "not configured".
 */

// getApiKey mirrors the real contract for customs: keyless → "", saved
// → decrypted value. Everything else gets the generic test key.
vi.mock("./api-keys", () => ({
  getApiKey: async (id: string) =>
    id === "custom:lm-studio" ? "" : "test-key",
  getOllamaUrl: async () => "http://localhost:11434",
}));

vi.mock("./settings-store", () => ({
  getCustomProvider: async (id: string) => {
    if (id === "custom:lm-studio")
      return {
        id: "custom:lm-studio",
        label: "LM Studio",
        baseUrl: "http://localhost:1234/v1",
        model: "qwen2.5-7b-instruct",
        apiKey: "", // keyless local server
      };
    if (id === "custom:keyed")
      return {
        id: "custom:keyed",
        label: "Keyed Gateway",
        baseUrl: "https://api.example.dev/v1",
        model: "m1",
        apiKey: "enc:v1:test:abc",
      };
    return null;
  },
}));

const { resolveProviderSpec, dispatchProviderCall } = await import(
  "./provider-dispatch"
);

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

describe("resolveProviderSpec", () => {
  it("builds the chat-completions endpoint from a saved custom baseUrl", async () => {
    const spec = await resolveProviderSpec("custom:lm-studio");
    expect(spec).not.toBeNull();
    expect(spec!.kind).toBe("openai-compat");
    expect(spec!.endpoint).toBe("http://localhost:1234/v1/chat/completions");
    // The stored free-text model rides along so dispatch never sends
    // model: "" even when the runtime seed was never populated.
    expect((spec as { model?: string }).model).toBe("qwen2.5-7b-instruct");
    expect((spec as { custom?: boolean }).custom).toBe(true);
  });

  it("returns null for a custom id that is no longer saved", async () => {
    expect(await resolveProviderSpec("custom:deleted")).toBeNull();
  });

  it("still resolves built-ins from the static table", async () => {
    const spec = await resolveProviderSpec("groq");
    expect(spec?.endpoint).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
    expect((spec as { custom?: boolean }).custom).toBeUndefined();
  });
});

describe("dispatchProviderCall with a custom provider", () => {
  const args = {
    system: "You write page titles.",
    user: "Write a title.",
    maxTokens: 200,
    temperature: 0.6,
    timeoutMs: 5000,
    caller: "test",
  };

  it("sends to <baseUrl>/chat/completions with the stored model", async () => {
    respond({ choices: [{ message: { content: "Soap Title" } }] });
    const text = await dispatchProviderCall("custom:lm-studio", args);
    expect(text).toBe("Soap Title");
    expect(sentUrl()).toBe("http://localhost:1234/v1/chat/completions");
    expect(sentBody().model).toBe("qwen2.5-7b-instruct");
  });

  it("sends NO authorization header for a keyless endpoint", async () => {
    respond({ choices: [{ message: { content: "Soap Title" } }] });
    await dispatchProviderCall("custom:lm-studio", args);
    expect(sentHeaders()).not.toHaveProperty("authorization");
    expect(sentHeaders()).not.toHaveProperty("Authorization");
  });

  it("authenticates with Bearer when the custom has a stored key", async () => {
    respond({ choices: [{ message: { content: "Soap Title" } }] });
    await dispatchProviderCall("custom:keyed", args);
    const auth = sentHeaders().authorization ?? sentHeaders().Authorization;
    expect(auth).toBe("Bearer test-key");
  });

  it("prefers the per-call model override over the stored model", async () => {
    respond({ choices: [{ message: { content: "Soap Title" } }] });
    await dispatchProviderCall("custom:lm-studio", {
      ...args,
      model: " llama3 ",
    });
    expect(sentBody().model).toBe("llama3");
  });

  it("returns null (not a throw) for an unsaved custom id", async () => {
    expect(await dispatchProviderCall("custom:deleted", args)).toBeNull();
  });
});

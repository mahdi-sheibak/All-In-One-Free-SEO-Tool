import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Test-provider probe for custom endpoints.
 *
 * The contract: the "Test connection" button for a `custom:<slug>` id
 * must probe exactly what real dispatch sends — the resolver-produced
 * `<baseUrl>/chat/completions` endpoint with the stored model — never
 * a hardcoded fallback URL, and never an empty `Bearer ` header for a
 * keyless local server.
 */

vi.mock("@/lib/api-keys", () => ({
  getApiKey: async (id: string) => (id === "custom:keyed" ? "sk-test" : null),
  getOllamaUrl: async () => null,
}));

vi.mock("@/lib/settings-store", () => ({
  getCustomProvider: async (id: string) =>
    id === "custom:lm-studio"
      ? {
          id: "custom:lm-studio",
          label: "LM Studio",
          baseUrl: "http://localhost:1234/v1",
          model: "qwen2.5-7b-instruct",
          apiKey: "",
        }
      : null,
}));

vi.mock("@/lib/provider-dispatch", () => ({
  // Mirrors the real resolver contract for the saved row: endpoint =
  // baseUrl + /chat/completions, stored model, resolved key, custom
  // flag. Keyless row → apiKey "".
  resolveProviderSpec: async (id: string) => {
    if (id === "custom:lm-studio")
      return {
        id,
        kind: "openai-compat",
        endpoint: "http://localhost:1234/v1/chat/completions",
        model: "qwen2.5-7b-instruct",
        apiKey: "",
        custom: true,
      };
    if (id === "custom:keyed")
      return {
        id,
        kind: "openai-compat",
        endpoint: "https://api.example.dev/v1/chat/completions",
        model: "m1",
        apiKey: "sk-test",
        custom: true,
      };
    if (id === "custom:nomodel")
      return {
        id,
        kind: "openai-compat",
        endpoint: "http://localhost:1234/v1/chat/completions",
        model: "",
        apiKey: "",
        custom: true,
      };
    return null;
  },
}));

const { POST } = await import("./route");

let fetchMock: ReturnType<typeof vi.fn>;

function post(provider: string) {
  return POST(
    new Request("http://localhost/api/test-provider", {
      method: "POST",
      body: JSON.stringify({ provider }),
    }),
  );
}

function sentInit() {
  return (fetchMock.mock.calls[0]?.[1] ?? {}) as {
    headers?: Record<string, string>;
    body?: string;
  };
}

beforeEach(() => {
  fetchMock = vi.fn();
  const okBody = { choices: [{ message: { content: "Connected." } }] };
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "",
    // Mirror a real Response: text() returns the serialized body, so
    // the probe's text-first JSON.parse sees the same bytes a real
    // gateway sends (an empty text body must fail parsing, not pass).
    json: async () => okBody,
    text: async () => JSON.stringify(okBody),
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("test-provider route, custom branch", () => {
  it("probes <baseUrl>/chat/completions with the stored model", async () => {
    const res = await post("custom:keyed");
    const json = (await res.json()) as { ok: boolean; reply?: string };
    expect(json.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.example.dev/v1/chat/completions",
    );
    const body = JSON.parse(sentInit().body ?? "{}");
    expect(body.model).toBe("m1");
  });

  it("requests a non-streaming reply (stream:false) from the endpoint", async () => {
    // Servers that stream by default answer 200 with SSE/NDJSON bodies
    // that no JSON parser accepts; the probe must pin streaming off so
    // a passing Test means real dispatch (which also sends stream:false)
    // will behave the same way.
    await post("custom:keyed");
    const body = JSON.parse(sentInit().body ?? "{}");
    expect(body.stream).toBe(false);
  });

  it("reports a 200 non-JSON reply with the body prefix, not a parser error", async () => {
    // Regression: a gateway that answers 200 with concatenated JSON
    // objects used to surface V8's "Unexpected non-whitespace character
    // after JSON at position 790" — true but useless. The error must
    // show what actually came back so the misbehaving server is
    // diagnosable from the Test button alone.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "",
      text: async () =>
        '{"choices":[{"message":{"content":"Connected."}}]}{"trailing":true}',
      json: async () => {
        throw new Error("res.json() must not be reached");
      },
    });
    const res = await post("custom:keyed");
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("non-JSON body");
    expect(json.error).toContain('"trailing":true');
  });

  it("reports an SSE streaming reply as such, not as a JSON failure", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "",
      text: async () =>
        'data: {"choices":[{"delta":{"content":"Con"}}]}\n\ndata: [DONE]\n\n',
      json: async () => {
        throw new Error("res.json() must not be reached");
      },
    });
    const res = await post("custom:keyed");
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("streaming body");
  });

  it("sends no auth header for a keyless custom endpoint", async () => {
    const res = await post("custom:lm-studio");
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(sentInit().headers).not.toHaveProperty("authorization");
    expect(sentInit().headers).not.toHaveProperty("Authorization");
  });

  it("reports a friendly error when the custom id is unsaved", async () => {
    const res = await post("custom:deleted");
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("not saved");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a friendly error when no model is set", async () => {
    const res = await post("custom:nomodel");
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("No model set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

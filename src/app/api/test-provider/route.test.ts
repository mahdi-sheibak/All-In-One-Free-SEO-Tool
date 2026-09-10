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
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "",
    json: async () => ({
      choices: [{ message: { content: "Connected." } }],
    }),
    text: async () => "",
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

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Custom providers in the AI-visibility fanout.
 *
 * A saved custom endpoint must be checkable through the same
 * checkOneProvider path as built-ins: request goes to the stored base
 * URL's chat-completions endpoint with the stored model, keyless
 * endpoints send no auth header, and the result is honestly grounded
 * "memory" (custom endpoints are plain chat-completions — no retrieval,
 * so prose URLs must not count as citations).
 */

vi.mock("./api-keys", () => ({
  getApiKey: async (id: string) => (id === "custom:keyed" ? "sk-test" : ""),
  getOllamaUrl: async () => null,
}));

vi.mock("./settings-store", () => ({
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

// resolveProviderSpec is the same resolver dispatch uses — the unit
// under test composes it with the citation extraction, so mock the
// resolver to the real contract (endpoint/model/apiKey) instead of
// dragging the whole dispatch module graph in.
vi.mock("./provider-dispatch", () => ({
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
    return null;
  },
}));

// Keep the Playwright browser-pool module graph out of the unit test.
vi.mock("./ai-search-scrapers", () => ({
  scrapeGoogleAiMode: vi.fn(),
  scrapeCopilot: vi.fn(),
}));

const { checkOneProvider } = await import("./llm-citation");

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "",
    json: async () => ({
      choices: [
        {
          message: {
            content:
              "Yes, example.com is often mentioned. See https://example.com/guide for details.",
          },
        },
      ],
    }),
    text: async () => "",
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("checkOneProvider with a custom provider", () => {
  it("probes the stored chat-completions endpoint with the stored model", async () => {
    const r = await checkOneProvider(
      "custom:lm-studio",
      "best handmade soap",
      "example.com",
    );
    expect(r.error).toBeUndefined();
    const url = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(url).toBe("http://localhost:1234/v1/chat/completions");
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body: string }).body,
    );
    expect(body.model).toBe("qwen2.5-7b-instruct");
    expect(r.response).toContain("example.com");
  });

  it("sends no auth header for a keyless custom endpoint", async () => {
    await checkOneProvider("custom:lm-studio", "q", "example.com");
    const headers = (
      fetchMock.mock.calls[0]?.[1] as {
        headers: Record<string, string>;
      }
    ).headers;
    expect(headers).not.toHaveProperty("authorization");
  });

  it("stays grounded as memory — prose URLs are not citations", async () => {
    const r = await checkOneProvider(
      "custom:lm-studio",
      "best handmade soap",
      "example.com",
    );
    expect(r.grounding).toBe("memory");
    // grounding "memory" → extractedUrls stays empty, so the mention
    // counts but the URL the model typed is not treated as evidence.
    expect(r.citations).toEqual([]);
    expect(r.mentionsDomain).toBe(true);
  });

  it("reports a friendly error for a custom id that is no longer saved", async () => {
    const r = await checkOneProvider("custom:gone", "q", "example.com");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.error).toContain("no longer configured");
  });
});

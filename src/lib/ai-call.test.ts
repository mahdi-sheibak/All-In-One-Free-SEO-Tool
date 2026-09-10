import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Custom providers through the callAI override path.
 *
 * The regression being pinned: a custom provider is dispatchable as
 * soon as it is SAVED — including keyless local endpoints, where
 * getApiKey returns "" (falsy). The old override check treated a falsy
 * key as "not configured", which would have silently rejected every
 * keyless custom endpoint and fallen back to the workspace default.
 */

vi.mock("./api-keys", () => ({
  // No keys saved anywhere: only the custom branch (which never asks
  // for a key) can pass the override check in these tests.
  getApiKey: async () => null,
  getOllamaUrl: async () => null,
  getActiveProvider: async () => null,
}));

vi.mock("./settings-store", () => ({
  getSetting: async () => false, // credit-saver off
  getCustomProvider: async (id: string) =>
    id === "custom:lm-studio"
      ? {
          id: "custom:lm-studio",
          label: "LM Studio",
          baseUrl: "http://localhost:1234/v1",
          model: "qwen2.5-7b-instruct",
          apiKey: "", // keyless local server
        }
      : null,
}));

vi.mock("./ai-usage", () => ({
  checkMonthlyCap: vi.fn(async () => ({ capped: false, capUsd: null })),
  logAiCall: vi.fn(async () => {}),
}));

vi.mock("./provider-dispatch", () => ({
  dispatchProviderCall: vi.fn(async () => "Dispatched!"),
  resolveDefaultModel: vi.fn(async (id: string) =>
    id === "custom:lm-studio" ? "qwen2.5-7b-instruct" : "catalog-default",
  ),
}));

const { callAIResult } = await import("./ai-call");
const { dispatchProviderCall } = await import("./provider-dispatch");
const { logAiCall } = await import("./ai-usage");

const base = {
  system: "You write page titles.",
  user: "Write a title for handmade soap.",
  maxTokens: 200,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("callAIResult with a custom provider override", () => {
  it("dispatches a saved keyless custom provider with its stored model", async () => {
    const r = await callAIResult({
      ...base,
      providerOverride: "custom:lm-studio",
    });
    expect(r).toEqual({ ok: true, text: "Dispatched!" });
    expect(dispatchProviderCall).toHaveBeenCalledTimes(1);
    const [providerId, args] = vi.mocked(dispatchProviderCall).mock
      .calls[0] as [string, { model: string }];
    expect(providerId).toBe("custom:lm-studio");
    expect(args.model).toBe("qwen2.5-7b-instruct");
  });

  it("records the custom id in the usage log", async () => {
    await callAIResult({ ...base, providerOverride: "custom:lm-studio" });
    expect(logAiCall).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "custom:lm-studio" }),
    );
  });

  it("prefers the per-call model override over the stored model", async () => {
    await callAIResult({
      ...base,
      providerOverride: "custom:lm-studio",
      modelOverride: " llama3 ",
    });
    const [, args] = vi.mocked(dispatchProviderCall).mock.calls[0] as [
      string,
      { model: string },
    ];
    expect(args.model).toBe("llama3");
  });

  it("falls back to no-provider when the custom id is unsaved", async () => {
    const r = await callAIResult({
      ...base,
      providerOverride: "custom:unsaved",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("no_provider");
    expect(dispatchProviderCall).not.toHaveBeenCalled();
  });

  it("still rejects a built-in override with no key saved", async () => {
    const r = await callAIResult({ ...base, providerOverride: "groq" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("no_provider");
    expect(dispatchProviderCall).not.toHaveBeenCalled();
  });
});

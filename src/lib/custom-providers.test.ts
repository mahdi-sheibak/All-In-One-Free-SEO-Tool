import { describe, expect, it } from "vitest";
import {
  normalizeBaseUrl,
  parseCustomProviders,
  removeCustomProvider,
  slugifyProviderLabel,
  uniqueCustomId,
  type CustomProvider,
} from "./custom-providers";
import {
  customModelFor,
  defaultModelFor,
  providerLabel,
  seedCustomProviderMeta,
} from "./ai-model-presets";

/**
 * Pure-logic tests for custom OpenAI-compatible providers — no DB, no
 * mocks, per the vitest rule in .agent/README.md (anything touching the
 * SQLite handle belongs to a future e2e project).
 *
 * The behaviors that matter most in production are the ones that keep a
 * corrupt settings row from poisoning AI dispatch:
 *   - parseCustomProviders DROPS malformed entries instead of throwing
 *   - normalizeBaseUrl rejects anything but http(s) so the dispatcher's
 *     `<base>/chat/completions` fetch is always well-formed
 *   - ids are always `custom:<slug>` and unique, so deleteCustomProvider
 *     can't be tricked into removing a catalog provider
 */

const validEntry: CustomProvider = {
  id: "custom:lm-studio",
  label: "LM Studio",
  baseUrl: "http://localhost:1234/v1",
  apiKey: "enc:v1:test:ciphertext",
  model: "qwen2.5-7b-instruct",
};

describe("normalizeBaseUrl", () => {
  it("accepts http and https and strips trailing slashes", () => {
    expect(normalizeBaseUrl("http://localhost:1234/v1")).toBe(
      "http://localhost:1234/v1",
    );
    expect(normalizeBaseUrl("http://localhost:1234/v1///")).toBe(
      "http://localhost:1234/v1",
    );
    expect(normalizeBaseUrl("https://api.example.com")).toBe(
      "https://api.example.com",
    );
  });

  it("trims whitespace before parsing", () => {
    expect(normalizeBaseUrl("  http://localhost:1234/v1  ")).toBe(
      "http://localhost:1234/v1",
    );
  });

  it("rejects non-http schemes, garbage, and empty input", () => {
    // file:, ws:, data: must never reach fetch() — the scheme check is
    // the one hard security boundary this feature has.
    expect(normalizeBaseUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeBaseUrl("ws://localhost:1234")).toBeNull();
    expect(normalizeBaseUrl("data:text/plain,hi")).toBeNull();
    expect(normalizeBaseUrl("not a url")).toBeNull();
    expect(normalizeBaseUrl("")).toBeNull();
    expect(normalizeBaseUrl("   ")).toBeNull();
    // A bare host without a scheme doesn't parse as http — require the
    // user to be explicit rather than guessing http vs https.
    expect(normalizeBaseUrl("localhost:1234")).toBeNull();
  });
});

describe("slugifyProviderLabel", () => {
  it("lowercases and collapses non-alphanumerics into dashes", () => {
    expect(slugifyProviderLabel("LM Studio (local)")).toBe("lm-studio-local");
    expect(slugifyProviderLabel("My vLLM Server!")).toBe("my-vllm-server");
  });

  it("keeps unicode letters so non-Latin labels survive", () => {
    // \p{L} keeps readable slugs for non-English users — the whole
    // point of user-named providers.
    expect(slugifyProviderLabel("Modèle-français")).toBe("modèle-français");
  });

  it("caps length at 40 chars and falls back when empty", () => {
    const long = "a".repeat(60);
    expect(slugifyProviderLabel(long).length).toBe(40);
    expect(slugifyProviderLabel("!!!")).toBe("provider");
    expect(slugifyProviderLabel("")).toBe("provider");
  });
});

describe("uniqueCustomId", () => {
  it("uses the plain slug when free", () => {
    expect(uniqueCustomId([], "LM Studio")).toBe("custom:lm-studio");
  });

  it("appends -2, -3 … when the slug is taken", () => {
    const existing: CustomProvider[] = [
      { ...validEntry, id: "custom:lm-studio" },
      { ...validEntry, id: "custom:lm-studio-2" },
    ];
    expect(uniqueCustomId(existing, "LM Studio")).toBe("custom:lm-studio-3");
  });

  it("ignores ids with other bases when picking suffixes", () => {
    const existing: CustomProvider[] = [{ ...validEntry, id: "custom:vllm" }];
    expect(uniqueCustomId(existing, "LM Studio")).toBe("custom:lm-studio");
  });
});

describe("parseCustomProviders", () => {
  it("returns [] for null, undefined, and non-array values", () => {
    expect(parseCustomProviders(null)).toEqual([]);
    expect(parseCustomProviders(undefined)).toEqual([]);
    expect(parseCustomProviders("nope")).toEqual([]);
    expect(parseCustomProviders({ id: "custom:x" })).toEqual([]);
  });

  it("recovers a double-encoded JSON string", () => {
    // getSetting returns JSON.parse output, but a hand-edited row could
    // be double-encoded. Recover instead of wiping the user's list.
    const list = [validEntry];
    expect(parseCustomProviders(JSON.stringify(list))).toEqual(list);
  });

  it("keeps valid entries and trims their fields", () => {
    const parsed = parseCustomProviders([
      { ...validEntry, label: "  LM Studio  ", model: " qwen " },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe("LM Studio");
    expect(parsed[0].model).toBe("qwen");
    expect(parsed[0].baseUrl).toBe("http://localhost:1234/v1");
  });

  it("defaults apiKey to empty string when absent (keyless endpoint)", () => {
    const parsed = parseCustomProviders([{ ...validEntry, apiKey: undefined }]);
    expect(parsed[0].apiKey).toBe("");
  });

  it("drops malformed entries instead of throwing", () => {
    // THE critical property: one bad entry in a hand-edited row must
    // never break every AI call for the other entries.
    const parsed = parseCustomProviders([
      null, // not an object
      "string entry", // not an object
      { ...validEntry, id: "lm-studio" }, // id missing custom: prefix
      { ...validEntry, label: "" }, // empty label
      { ...validEntry, baseUrl: "file:///etc" }, // bad scheme
      { ...validEntry, baseUrl: "http://x/y", model: "" }, // empty model
      validEntry, // good — must survive
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("custom:lm-studio");
  });

  it("dedupes by id, first entry wins", () => {
    const dupe = { ...validEntry, label: "Imposter" };
    const parsed = parseCustomProviders([validEntry, dupe]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe("LM Studio");
  });
});

describe("removeCustomProvider", () => {
  it("filters by id without mutating the input", () => {
    const list: CustomProvider[] = [
      validEntry,
      { ...validEntry, id: "custom:vllm" },
    ];
    const next = removeCustomProvider(list, "custom:lm-studio");
    expect(next.map((p) => p.id)).toEqual(["custom:vllm"]);
    expect(list).toHaveLength(2); // original untouched
  });
});

describe("custom provider metadata seeding (ai-model-presets)", () => {
  it("defaultModelFor returns the seeded model for custom ids", () => {
    seedCustomProviderMeta([
      {
        id: "custom:lm-studio",
        label: "LM Studio",
        model: "qwen2.5-7b-instruct",
      },
    ]);
    expect(defaultModelFor("custom:lm-studio")).toBe("qwen2.5-7b-instruct");
    // Unseeded ids (and built-ins) unaffected:
    expect(defaultModelFor("custom:unknown")).toBe("");
    expect(defaultModelFor("gemini")).toBe("gemini-2.0-flash");
  });

  it("customModelFor reads the seed; unknown ids return empty", () => {
    seedCustomProviderMeta([{ id: "custom:a", label: "A", model: "model-a" }]);
    expect(customModelFor("custom:a")).toBe("model-a");
    expect(customModelFor("custom:b")).toBe("");
  });

  it("providerLabel uses seeded label, falls back to slug, never leaks into static labels", () => {
    seedCustomProviderMeta([
      { id: "custom:lm-studio", label: "LM Studio", model: "m" },
    ]);
    expect(providerLabel("custom:lm-studio")).toBe("LM Studio");
    expect(providerLabel("custom:unseeded-id")).toBe("unseeded-id");
    // Built-ins still come from the static map:
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("ollama")).toBe("Ollama (local)");
  });

  it("reseeding replaces, not merges, stale entries", () => {
    seedCustomProviderMeta([
      { id: "custom:a", label: "A", model: "m" },
      { id: "custom:b", label: "B", model: "m" },
    ]);
    seedCustomProviderMeta([{ id: "custom:c", label: "C", model: "m" }]);
    expect(customModelFor("custom:a")).toBe("");
    expect(customModelFor("custom:c")).toBe("m");
  });
});

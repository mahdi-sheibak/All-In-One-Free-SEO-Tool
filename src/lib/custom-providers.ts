/**
 * Custom OpenAI-compatible providers — pure logic + shared types.
 *
 * A "custom provider" is any OpenAI-compatible chat-completions endpoint
 * the user registers by hand: LM Studio, llama.cpp server, vLLM, LiteLLM,
 * a niche cloud gateway — anything that speaks
 * `POST <base>/chat/completions` and returns `choices[0].message.content`.
 *
 * Custom providers are stored as a JSON list under the single settings
 * row `ai.custom_providers` (no DB migration needed — the row is TEXT).
 * This module holds everything about them that must stay testable
 * without opening the SQLite handle: the stored shape, the parse/validate
 * rules for that JSON, and the id/URL helpers used by both the server
 * actions and the dispatcher.
 *
 * The DB accessors (getCustomProviders / saveCustomProviders) live in
 * settings-store.ts; the server actions that mutate the list live in
 * app/settings/key-actions.ts.
 */

import type { CustomProviderId } from "./api-providers";
import { isCustomProvider } from "./api-providers";

/**
 * One user-registered provider.
 *
 * `apiKey` is stored ENCRYPTED (crypto.ts `enc:v1:...` format), same as
 * every built-in key. An empty string means "no key" — plenty of local
 * gateways (LM Studio, llama.cpp) accept unauthenticated requests.
 */
export type CustomProvider = {
 /** `custom:<slug>` — slug is derived from the label and unique in the list. */
 id: CustomProviderId;
 /** User-facing name, free text. */
 label: string;
 /** Base URL WITHOUT the /chat/completions suffix and WITHOUT trailing slashes. */
 baseUrl: string;
 /** Encrypted API key, or "" when the endpoint needs no auth. */
 apiKey: string;
 /** Model id sent as the `model` field — free text, e.g. "qwen2.5-7b-instruct". */
 model: string;
};

/** The settings row key the list is persisted under. */
export const CUSTOM_PROVIDERS_SETTING_KEY = "ai.custom_providers" as const;

/**
 * Parse the stored settings value into a validated list.
 *
 * Never throws. Anything malformed is DROPPED (not repaired) so a
 * hand-edited or partially-corrupt row can't poison dispatch with a
 * provider whose baseUrl would produce `null/chat/completions`. An
 * unparseable value yields [] — the feature degrades to "no custom
 * providers configured", which the UI treats as the normal empty state.
 */
export function parseCustomProviders(value: unknown): CustomProvider[] {
 if (value === null || value === undefined) return [];
 let raw: unknown;
 if (typeof value === "string") {
  // Defensive: getSetting returns whatever JSON.parse produced, so a
  // string here means the row was double-encoded. Try to recover.
  try {
   raw = JSON.parse(value);
  } catch {
   return [];
  }
 } else {
  raw = value;
 }
 if (!Array.isArray(raw)) return [];

 const out: CustomProvider[] = [];
 for (const entry of raw) {
  const p = entry as Partial<CustomProvider> | null;
  if (!p || typeof p !== "object") continue;
  if (typeof p.id !== "string" || !isCustomProvider(p.id)) continue;
  if (typeof p.label !== "string" || !p.label.trim()) continue;
  const baseUrl =
   typeof p.baseUrl === "string" ? normalizeBaseUrl(p.baseUrl) : null;
  if (!baseUrl) continue;
  if (typeof p.model !== "string" || !p.model.trim()) continue;
  // apiKey: encrypted string or "" — never a nested object.
  if (
   p.apiKey !== undefined &&
   p.apiKey !== "" &&
   typeof p.apiKey !== "string"
  ) {
   continue;
  }
  // Dedupe by id — first entry wins, later duplicates are ignored.
  if (out.some((e) => e.id === p.id)) continue;
  out.push({
   id: p.id as CustomProviderId,
   label: p.label.trim(),
   baseUrl,
   apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
   model: p.model.trim(),
  });
 }
 return out;
}

/**
 * Validate + normalize a base URL from user input.
 *
 * Returns the normalized URL (trailing slashes stripped) or null when
 * invalid. Only http/https are accepted — no file:, no ws:, no data:.
 *
 * SSRF stance: this is the same trust class as the Ollama URL the user
 * can already point at localhost or their LAN. Custom endpoints are
 * admin-supplied config in a single-user local-first app, so no
 * url-guard blocklist here — but the scheme restriction keeps the
 * fetch() call well-formed and prevents `file://`-style surprises.
 */
export function normalizeBaseUrl(raw: string): string | null {
 const trimmed = raw.trim();
 if (!trimmed) return null;
 let url: URL;
 try {
  url = new URL(trimmed);
 } catch {
  return null;
 }
 if (url.protocol !== "http:" && url.protocol !== "https:") return null;
 // Strip ALL trailing slashes so `http://host:1234/v1` and
 // `http://host:1234/v1///` produce the same endpoint. (The dispatcher
 // appends exactly one `/chat/completions`.)
 return trimmed.replace(/\/+$/, "");
}

/**
 * Turn a label into an id slug: lowercase, alphanumerics and dashes.
 * "LM Studio (local)" → "lm-studio-local". Empty → "provider".
 */
export function slugifyProviderLabel(label: string): string {
 const slug = label
  .toLowerCase()
  .trim()
  // Keep unicode letters/numbers so non-Latin labels stay readable,
  // collapse everything else into single dashes.
  .replace(/[^\p{L}\p{N}]+/gu, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 40)
  .replace(/-+$/g, "");
 return slug || "provider";
}

/**
 * Build a unique id for a new provider: `custom:<slug>`, deduped by
 * appending -2, -3, … when the slug is already taken in the list.
 */
export function uniqueCustomId(
 existing: CustomProvider[],
 label: string,
): CustomProviderId {
 const base = slugifyProviderLabel(label);
 const taken = new Set(existing.map((p) => p.id));
 if (!taken.has(`custom:${base}` as CustomProviderId)) {
  return `custom:${base}` as CustomProviderId;
 }
 let n = 2;
 while (taken.has(`custom:${base}-${n}` as CustomProviderId)) n++;
 return `custom:${base}-${n}` as CustomProviderId;
}

/** Remove a provider from a list by id. Pure — the caller persists the result. */
export function removeCustomProvider(
 list: CustomProvider[],
 id: string,
): CustomProvider[] {
 return list.filter((p) => p.id !== id);
}

/**
 * Client-safe public shape of a custom provider — NO key material.
 * `hasKey` replaces the secret; this is what listConfiguredProviders
 * ships to the browser and what the settings card + model picker render.
 */
export type CustomProviderPublicMeta = {
 id: CustomProviderId;
 label: string;
 /** Shown for edit-seeding + the row's endpoint display — a URL is
  * not secret, unlike the key (which hasKey summarizes). */
 baseUrl: string;
 model: string;
 /** True when an encrypted key is stored (false = keyless endpoint). */
 hasKey: boolean;
};

/** Strip key material before transport to the client. */
export function toPublicMeta(
 list: CustomProvider[],
): CustomProviderPublicMeta[] {
 return list.map(({ id, label, baseUrl, model, apiKey }) => ({
  id,
  label,
  baseUrl,
  model,
  hasKey: apiKey.length > 0,
 }));
}

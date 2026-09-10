# Design: Custom OpenAI-compatible providers

## Context

The AI layer is layered as: static catalog (`api-providers.ts`) → key/state (`api-keys.ts`) → dispatch (`provider-dispatch.ts`) → shared wire callers (`providers/*`). Nine of twelve providers already route through `callOpenAICompat`, where endpoint, key, and model are parameters. The blocker for dynamic providers is that every layer above the wire callers assumes the provider set is a compile-time-closed union: ~8 `Record<Provider, ...>` maps (`SETTING_KEY`, `ENV_VAR`, `PROVIDER_DISPATCH`, `MODEL_PRESETS`, `PROVIDER_LABEL`, `ALLOWED_KEYS`, `PROVIDER_GROUNDING`) and validation switches in `key-actions.ts`, `test-provider/route.ts`, `llm-citation.ts`, `ai-vision.ts`, and `assistant/actions.ts`.

Storage options considered: new drizzle table vs one JSON settings row. The app already encrypts provider keys through `crypto.ts` into settings rows; `ai_calls.provider` is a TEXT column; custom-provider lists are small (handfuls of entries, always read as a whole). A table buys per-row SQL joins that nothing needs today.

Relevant existing behaviors to preserve: `PROVIDER_GROUNDING[provider] ?? "memory"` fallback in `llm-citation.ts`, estimated-rate fallback in `ai-cost.ts` for unknown models, and settings-store encryption on save.

## Goals / Non-Goals

**Goals:**

- Custom provider ids (`custom:<id>`) flow through every existing AI path with minimal per-path branches.
- Zero database migration; zero new dependencies.
- Reuse `callOpenAICompat` unchanged as the wire caller.
- Fix the two latent activation bugs (setActiveProvider allowlist, assistant chat chain) while touching those files anyway.

**Non-Goals:**

- No `GET /models` discovery button (deferred; free-text model ids only in v1).
- No per-custom-provider cost rates (unknown models use the existing estimated-rate fallback).
- No change to the built-in catalog's 12 entries or their presets.
- No Azure-style non-Bearer auth variants (base URL + Bearer only; endpoints needing `api-key` headers are out of scope).

## Decisions

### Storage: one JSON settings row

Store all custom providers as a JSON array under a single new SettingKey `ai.custom_providers`. Each entry: `{ id, label, baseUrl, apiKey (encrypted), model }`.

- Alternative rejected (drizzle table + migration #65): nothing queries custom providers per-row; a JSON row avoids a migration and keeps deletion/edit atomic in one settings write.
- `id` is a short slug generated from the label (sanitized, deduped with a numeric suffix). Provider id in the system is `custom:<slug>`.

### Type shape: template-literal union, records keep static keys

Extend `ActiveProvider` with `` `custom:${string}` ``. Static `Record<ActiveProvider, ...>` maps that cannot enumerate the pattern become plain objects keyed by static providers plus small resolver functions:

- `defaultModelFor(provider)`: static map hit, or the stored custom model for `custom:*`.
- `providerLabel(provider)`: static map hit, or the stored custom label.
- `resolveProviderSpec(provider)` in dispatch: static `PROVIDER_DISPATCH` hit, or `{ kind: "openai-compat", endpoint: baseUrl + "/chat/completions" }` built from settings.

This keeps diffs local: no wholesale conversion of every map into functions, only the ones that must resolve dynamic ids get a helper.

### Dispatch: one branch, not a rewrite

`callAI` keeps its current flow. Where it resolves the provider spec, a `custom:*` id resolves from the JSON row via a new `getCustomProvider(id)` accessor in `api-keys.ts`. The resolved spec reuses `kind: "openai-compat"`, so retries, timeouts, and error classification are inherited. Keyless custom providers pass an empty key; `callOpenAICompat` omits the `Authorization` header when the key is blank.

### Base URL convention

Store the base URL exactly as entered minus trailing slashes; the endpoint is `base + "/chat/completions"`. Validation: `URL` parse must succeed, scheme must be `http:` or `https:`. No url-guard: custom endpoints are admin-supplied config in the same trust class as the Ollama URL (which is also user-supplied and unguarded). Documented in the security audit appendix.

### Key handling

On save, encrypt with the same helpers `saveApiKey` uses. Server actions return provider entries with `apiKey` replaced by a boolean `hasKey` (or masked placeholder) so plaintext never round-trips to the client. Editing with a blank key field preserves the stored key; an explicit "clear" checkbox removes it.

### Settings UI

A dedicated "Custom providers" card below the built-in catalog cards: list of saved providers (label, model, active state) with add/edit/delete forms. Server actions in `key-actions.ts` (`saveCustomProvider`, `deleteCustomProvider`). The model picker renders a text input seeded with the stored model when the active provider is custom, instead of the preset `<select>`.

### Latent bug fixes in passing

- `setActiveProvider` allowlist: replace the hardcoded 7-id array with the full catalog id list (plus ollama/custom handling) so mistral, deepseek, cerebras, together, github activate.
- `assistant/actions.ts` chat chain: route unknown/legacy providers through the same dispatch resolution instead of per-provider if/else, or at minimum add the missing branches. Full migration of that chain to dispatch is preferred if diff size allows; it removes a duplicated dispatch table.

## Risks / Trade-offs

- [Template-literal ids leak into code that assumes finite `Provider`] → Keep the union extension narrow: only files that already switch on provider ids change. Grep for `Record<ActiveProvider` and `Record<Provider` during implementation to catch all maps.
- [JSON row corruption on concurrent writes] → Settings writes are single-process better-sqlite3 transactions; same risk profile as every other settings row. Validate JSON on read, fall back to empty list on parse failure.
- [Unguarded user-supplied URLs widen SSRF surface] → Accepted deliberately (Ollama precedent, admin-supplied config). Restrict scheme to http(s); document in `.agent/02-security-audit.md`. Open-mode installs (no password) already trust their network for settings changes.
- [Usage-log ambiguity: `custom:<slug>` reused after re-pointing a provider] → v1 accepts it. Slug ids make logs readable; exact endpoint provenance per historical call is not tracked today for built-ins either.
- [Assistant chat refactor scope creep] → If the full dispatch migration of `assistant/actions.ts` balloons, ship the minimal missing-branches fix and record the migration as a follow-up task.

## Migration Plan

No data migration: the feature reads one new settings key. Rollback is removing the UI card and dispatch branch; leftover `ai.custom_providers` rows are inert.

## Open Questions

None.

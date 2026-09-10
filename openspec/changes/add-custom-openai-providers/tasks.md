## 1. Core types and storage

- [x] 1.1 Add SettingKey `ai.custom_providers` to settings-store and a `CustomProvider` type (`id`, `label`, `baseUrl`, encrypted `apiKey`, `model`); add `getCustomProviders`/`getCustomProvider(id)`/`saveCustomProviders` accessors with JSON validation and empty-list fallback on parse failure. Verify with a unit test for round-trip save/read plus corrupt-JSON fallback.
- [x] 1.2 Extend `ActiveProvider` with `` `custom:${string}` `` in api-providers.ts (client-safe id helpers: `isCustomProvider`, `customProviderSlug`). Verify `pnpm run typecheck` passes.
- [x] 1.3 Add `configuredProviders()` support for custom ids in api-keys.ts: a custom provider counts as configured when saved; `getApiKey("custom:x")` returns its decrypted key (empty string when keyless). Verify with a unit test.

## 2. Dispatch and callers

- [x] 2.1 Add custom resolution to provider-dispatch: `resolveProviderSpec("custom:x")` returns `{ kind: "openai-compat", endpoint: baseUrl + "/chat/completions" }` from settings. Verify with a unit test (stored base URL produces the right endpoint; trailing slash normalized).
- [x] 2.2 In providers/openai-compat.ts, omit the `Authorization` header when the key is empty. Verify with a unit test asserting no auth header for a keyless call.
- [x] 2.3 Route `custom:*` through `callAI` (ai-call.ts): model from stored settings, provider label for errors, usage log provider id `custom:<slug>`. Verify with a unit test using a stubbed endpoint.
- [x] 2.4 Update ai-model-presets helpers: `defaultModelFor` and `providerLabel` return stored custom values for `custom:*` ids (no preset map change). Verify with a unit test; keep the existing single-source-of-truth test green.
- [x] 2.5 Include custom providers in llm-citation fanout (grounding via existing `?? "memory"` fallback) and ai-vision (OpenAI image format path). Verify with a unit test that fanout enumerates a saved custom provider.

## 3. Server actions and test probe

- [x] 3.1 In key-actions.ts add `saveCustomProvider` (validate: label/baseUrl/model required, URL parses with http/https scheme only, trailing slash stripped; slug generated from label and deduped; key encrypted, blank key field preserves stored key, explicit clear removes it) and `deleteCustomProvider` (resets active provider to default if the deleted one was active). Verify with unit tests for each validation branch and the delete-active reset.
- [x] 3.2 Fix `setActiveProvider` allowlist to accept all 12 catalog providers plus ollama and `custom:*` ids. Verify with a unit test that mistral/deepseek/cerebras/together/github now activate.
- [x] 3.3 Extend test-provider/route.ts with a custom-provider branch probing the stored base URL and model (reuse the dispatch spec rather than a new hardcoded endpoint). Verify with a unit test that a custom id probes `<baseUrl>/chat/completions`.

## 4. UI

- [x] 4.1 Create custom-providers card (list with label, model, active badge; add/edit/delete forms; masked key display, never plaintext round-trip) and mount it in settings below the catalog cards. Verify by rendering the settings page and confirming the card lists saved providers.
- [x] 4.2 Update ai-model-picker to render a free-text model input seeded with the stored model when the active provider is custom, persisting edits via saveCustomProvider. Verify by changing the model in the picker and confirming the next AI call uses it.
- [x] 4.3 Update active-provider flow (active-provider-card, api-keys-section) so custom providers appear as configured and settable active. Verify by activating a custom provider in the UI and dispatching a call.

## 5. Assistant chat and bug fixes

- [x] 5.1 Route assistant chat (assistant/actions.ts) through dispatch resolution for `custom:*` (preferred: replace the if/else chain with dispatch; minimal: add missing provider branches including customs). Verify chat works with a custom active provider and with each previously missing built-in (mistral, deepseek, cerebras, together, github).
- [x] 5.2 Update usage/cost path: confirm `ai_calls.provider` records `custom:<slug>` and ai-cost applies the estimated-rate fallback. Verify with a unit test.

## 6. Validation and docs

- [x] 6.1 Run `pnpm run lint && pnpm run typecheck && pnpm run test` and fix failures. Verify all three pass.
- [x] 6.2 Add an e2e test if the existing Playwright suite covers settings flows; otherwise manual verification checklist: add local LM Studio provider, activate, run a tool that uses AI, check usage log shows `custom:<slug>`. Verify by executing the checklist.
- [x] 6.3 Update `.agent/03-codebase-map.md` (custom provider layer notes) and `.agent/02-security-audit.md` (SSRF stance for user-supplied custom base URLs, http/https scheme restriction). Verify docs mention the scheme restriction and Ollama-precedent rationale.

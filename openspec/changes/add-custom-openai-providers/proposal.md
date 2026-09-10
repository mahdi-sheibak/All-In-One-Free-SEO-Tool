# Add custom OpenAI-compatible providers

## Why

The app ships 12 hardcoded AI providers. Users cannot add an OpenAI-compatible endpoint that is not in the catalog: local servers (LM Studio, llama.cpp, vLLM), LAN gateways (LiteLLM), or niche cloud providers. The wire-protocol layer already routes 9 of the 12 providers through one generic OpenAI-compatible caller where the endpoint is a parameter, so the only real barrier is that the provider set is a compile-time-closed union threaded through static record maps.

## What Changes

- Add user-defined custom AI providers (N per install). Each has: label, base URL (OpenAI-SDK convention), optional API key, and a free-text model id.
- Store custom providers as a JSON row in the existing settings store (`ai.custom_providers`); API keys use the existing encryption path. No database migration.
- Introduce provider ids of the form `custom:<id>` and extend `ActiveProvider` with a matching template-literal type. Static record lookups (`MODEL_PRESETS`, `PROVIDER_LABEL`, dispatch, key maps) gain helpers that resolve custom ids from settings at call time.
- Dispatch: a `custom:*` provider resolves its spec from settings and calls the existing `callOpenAICompat`. No new wire code.
- Settings UI: a custom-providers card with add/edit/delete, rendered alongside the static catalog cards. The active-provider flow and model picker accept custom ids (model picker uses a text input for custom providers).
- Custom providers join `configuredProviders()`, so they work everywhere a normal provider works: active selection, AI visibility fanout (grounding defaults to `memory`), vision (OpenAI image format), assistant chat, usage logging (`ai_calls.provider` is TEXT, stores `custom:<id>`), and cost estimation (unknown models get the existing estimated-rate fallback).
- Local endpoints: custom base URLs may point at localhost or private LAN addresses (same trust class as the existing user-supplied Ollama URL; not routed through url-guard). Restricted to `http(s)` schemes.
- Test-provider probe: support probing a custom provider with its stored base URL and model.
- Fix two latent bugs in passing: `setActiveProvider` allowlist is missing 5 catalog providers (mistral, deepseek, cerebras, together, github), and the assistant chat if/else chain handles the same 5 missing providers.

## Capabilities

### New Capabilities

- `custom-ai-providers`: Creating, editing, deleting, and selecting user-defined OpenAI-compatible providers; key storage and encryption; local endpoint policy; dispatch, probing, and model selection for custom ids; integration with existing AI features (visibility fanout, vision, assistant, usage/cost logging).

### Modified Capabilities

<!-- None: no specs exist yet in openspec/specs/. -->

## Impact

- Code: ~16-18 files. Core: `src/lib/api-providers.ts`, `api-keys.ts`, `ai-model-presets.ts`, `provider-dispatch.ts`, `ai-call.ts`, `settings-store.ts`. UI: `settings/page.tsx`, new custom-providers card component, `api-keys-section.tsx`, `active-provider-card.tsx`, `components/ai-model-picker.tsx`. Consumers: `api/test-provider/route.ts`, `key-actions.ts`, `llm-citation.ts`, `ai-vision.ts`, `assistant/actions.ts`, `api/ai-providers/actions.ts`.
- Database: none. Custom providers live in one settings row; `ai_calls.provider` already accepts arbitrary text.
- Dependencies: none added.
- Security: user-supplied base URLs are fetched without url-guard (documented decision, Ollama precedent). Keys encrypted with existing `crypto.ts` helpers.
- Docs: `.agent/03-codebase-map.md` provider notes and security audit appendix (SSRF stance) updated.

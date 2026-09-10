# 03 — Codebase map

Annotated map of the parts agents actually touch. Line counts are from
the 2026-09-10 audit (commit c520ea0).

## Top level

- `install.sh` / `install.ps1` — one-line installers (curl|iex entry).
  Download ZIP from codeload.github.com only. Non-technical-user path.
- `Dockerfile` / `docker-compose.yml` — multi-stage build on
  playwright:v1.56.0-noble; corepack-pinned pnpm; non-root pwuser;
  publishes 127.0.0.1:3000 by default; refuses boot unauthenticated when
  exposed. State on `seo-data` volume mounted at /data.
- `.npmrc` — disables pnpm build-script gate (see audit risk #1).
  `pnpm-workspace.yaml` + package.json `pnpm.onlyBuiltDependencies`
  hold the allowlist — both MUST stay in sync.
- `next.config.ts` — standalone output; serverExternalPackages for
  native modules (better-sqlite3, playwright, resvg, satori, qrcode);
  frame-ancestors headers (everything self-only, /embed carve-out).
- `drizzle.config.ts`, `vitest.config.ts`, `playwright.config.ts`,
  `eslint.config.mjs`, `components.json` (shadcn).
- `.env.example` — template only, no secrets. Real env lives in
  .env.local / docker-compose env (gitignored).
- `bin/` — START/STOP/seo launchers (sh + cmd), seo-doctor.cjs,
  seo-update.cjs (CLI update path = same steps as /api/update).
- `docs/` — AGENTS.md (Next.js v16 breaking-changes warning — read
  before writing Next code), HOSTING.md, ROADMAP.md, TROUBLESHOOTING.md,
  mcp-server.md, screenshots/.
- `e2e/` — Playwright specs: agency, shell, tools.
- `extension/` — MV3 browser extension "Quick Capture". localhost-only
  host_permissions; content.js extracts meta tags on message.
- `wordpress-plugin/seo-tool-bridge.php` (43k) — WP side of the bridge;
  authenticated by connection key header; clean of dangerous calls.
- `.github/workflows/ci.yml` — the ONLY workflow (21k): build+test+docker
  smoke, no secrets, localhost health checks.

## src/ layout

- `src/middleware.ts` (268) — THE auth gate. 3 modes: accounts >
  APP_PASSWORD > open. Edge side can't query DB; asks
  /api/auth/mode with 30s cache. PUBLIC_PATHS carve-outs documented
  (portal tokens, /api/v1 bearer keys, webhooks, health).
- `src/lib/admin-auth.ts` (160) — guardAdminRequest for destructive
  routes: CSRF (Sec-Fetch-Site/Origin) + local-request check,
  TRUSTED_PROXY-aware. Used by restart/shutdown/restore/backup/update/
  desktop-shortcut/report-pdf/skip-branding.
- `src/lib/url-guard.ts` — SSRF guard (blocks loopback, link-local
  169.254.x, metadata.google.internal). Tests in url-guard.test.ts.
- `src/lib/crypto.ts` — AES-256-GCM, key file .seo-encryption-key.
- `src/lib/api-auth.ts` — /api/v1 Bearer keys, sha256-hashed storage.
- `src/lib/session-token.ts` — HMAC-signed session cookie tokens.
- `src/lib/port-memory.ts` — remembers chosen port (.seo-port).
- `src/lib/audit.ts` (~1k+ lines) — crawler/auditor core.
- `src/lib/ai-*.ts` — AI layer: ai-call.ts (provider dispatch),
  ai-model-presets, ai-usage, ai-cost, ai-search-scrapers (ChatGPT/
  Perplexity/Gemini citation checks), ai-semaphore (concurrency).
- `src/lib/provider-dispatch.ts` — THE dispatch table: every AI call
  goes through `dispatchProviderCall(providerId, args)`. Static specs
  for the 12 catalog providers + ollama; `custom:*` ids resolve
  dynamically from the `ai.custom_providers` settings row via
  `resolveProviderSpec()` (endpoint = baseUrl + "/chat/completions",
  stored free-text model, decrypted key or keyless). Keyless customs
  send no Authorization header. Custom callers: assistant chat
  (multi-turn via DispatchArgs.history), llm-citation probes,
  /api/test-provider, ai-vision.
- `src/lib/custom-providers.ts` — pure helpers for the settings-store
  `ai.custom_providers` row (parse/normalize/slug/unique-id/remove,
  toPublicMeta strips key material for the client). Client-safe:
  no settings-store/db imports.
- `src/app/settings/custom-providers-card.tsx` + api/test-provider
  route — user-registered OpenAI-compatible endpoints (LM Studio,
  llama.cpp, vLLM...): CRUD card on /settings, activation through
  ActiveProviderCard (customs render as CUSTOM-tier buttons), probe
  route reuses resolveProviderSpec.
- `src/lib/rank-checker.ts`, `serp-scanner.ts`, `gbp-scraper.ts` —
  Playwright-driven scraping (Google SERP, local rank, GBP reviews).
- `src/lib/wp-hack-scanner.ts` — scans WP sites for injected malware
  patterns (ironically the most security-aware file in the repo).
- `src/lib/auto-backup.ts` — VACUUM INTO backups.
- `src/db/` — drizzle schema + 64 SQL migrations in src/db/migrations/
  (applied by scripts/migrate.cjs — filename-hash tracked, idempotent).

## src/app/api/ (selected routes)

- `/api/update` — GET check / POST git fetch+pull (force-sync fallback),
  pnpm install on package.json change, migrations. Admin-guarded.
- `/api/restart`, `/api/shutdown` — spawn launcher / exit. Admin-guarded;
  refuse inside Docker with guidance.
- `/api/backup`, `/api/restore` — SQLite export / header-validated
  replace (500MB cap). Admin-guarded. NOTE: restore/route.ts contains a
  literal NUL byte in the SQLite magic string → registers as binary to
  grep. Benign.
- `/api/desktop-shortcut` — PowerShell .lnk creation (win32 only).
- `/api/v1/*` — public API (clients, audits, keywords, rankings,
  reports, snapshots, capture, track-404, health). Bearer-key auth.
- `/api/webhooks/[token]`, `/portal/[token]` — token-authenticated.
- `/api/auth/*` — login/mode/team registration (first user = owner).

## scripts/

- `migrate.cjs` — production migration runner (better-sqlite3 direct,
  CJS, runs in Docker entrypoint + predev/prebuild).
- `mcp-server.ts` — stdio MCP server (@modelcontextprotocol/sdk);
  stdout is protocol-only. Runs as file owner; no network surface.
- `*-check.ts` / `*.mjs` — CI/self-test harnesses (agent-check,
  auth-check, grader-ssrf-check, mcp-check, wp-bridge-check,
  route-sweep, live-check...). fake-ollama.mjs / fake-wordpress.mjs are
  local test doubles.
- `package.ts` — bundles dist/ + Node binary for double-click users.

## Gotchas

1. Next.js 16 — breaking changes vs training data. docs/AGENTS.md
   insists on reading node_modules/next/dist/docs/ first.
2. pnpm config lives in THREE places (package.json pnpm block,
   pnpm-workspace.yaml, .npmrc). Keep allowlists in sync or installs
   half-build native deps depending on pnpm version.
3. src/app/api/restore/route.ts greps as binary (NUL literal) — exclude
   it or expect confusion.
4. Docker build needs pnpm-workspace.yaml copied BEFORE pnpm install
   (Dockerfile comments explain the ERR_PNPM_IGNORED_BUILDS dance).
5. The updater's force-sync wipes untracked non-gitignored files —
   never leave scratch files in the install dir.
6. Migrations: hash-vs-filename detection in migrate.cjs handles old
   drizzle-kit DBs; don't "simplify" it away.

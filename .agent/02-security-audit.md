# 02 — Security audit (static, read-only)

- Date: 2026-09-10
- Commit audited: `c520ea0` (HEAD, main, clean tree)
- Method: static analysis of the working tree. No install, no build, no
  network. Full report preserved in the original chat; this is the
  condensed canonical copy.

## Verdict

NO malicious code found. No backdoors, no data exfiltration, no
obfuscation, no telemetry, no phone-home beyond product features.
Codebase is unusually defensive; many security fixes are already applied
and documented inline.

## What was verified

1. Obfuscation: zero eval()/new Function/base64 payloads/certutil/
   `iex -enc`/`curl|sh` anywhere (src, scripts, bin, installers,
   extension, PHP plugin). All `.exec(` hits are JS RegExp — benign.
2. Process spawning — all execFile/array-args, no string-built shell:
   - src/app/api/restart/route.ts (relaunch launcher, admin-guarded)
   - src/app/api/update/route.ts (fixed git/pnpm args, admin-guarded)
   - src/app/api/desktop-shortcut/route.ts (PowerShell .lnk, guarded)
   - src/lib/unread-counts.ts (git rev-parse)
   - scripts/*.cjs (build/CI helpers)
3. `src/app/api/restore/route.ts` registers as BINARY to grep/file —
   FALSE ALARM: literal `"SQLite format 3\0"` contains a real NUL byte.
   File byte-identical to git HEAD. (Fix candidate: use `"\x00"`.)
4. Outbound network: GitHub API (update check), user-configured AI
   providers (OpenAI/Groq/OpenRouter/Anthropic/Perplexity/Ollama),
   Google suggest/SERP, Reddit, business directories. All product
   features. No analytics/Sentry/telemetry — matches the app's own
   claim on /about.
5. Installers: download only from github.com/codeload for the pinned
   repo; sudo only appears in help text; temps cleaned. No hidden
   payloads.
6. Secrets: none tracked. Only .env.example (template-only). API keys
   sha256-hashed (src/lib/api-auth.ts), sessions HMAC-signed
   (src/lib/session-token.ts), timing-safe compare in middleware.
7. Auth: 3-mode middleware gate; admin endpoints double-guarded
   (CSRF via Sec-Fetch-Site/Origin + local-request check; TRUSTED_PROXY
   aware) — src/lib/admin-auth.ts. Docker entrypoint refuses to boot
   exposed without APP_PASSWORD.
8. Docker: pinned base image + corepack pnpm pin, non-root (pwuser),
   127.0.0.1 publish default, state on /data volume.
9. SSRF guard src/lib/url-guard.ts: blocks localhost/link-local/
   metadata.google.internal + 169.254.x; comments show authors know the
   302-redirect bypass class. WP private endpoints need explicit
   SEO_ALLOW_PRIVATE_WP_ENDPOINT=1.
10. WordPress bridge PHP: no eval/base64_decode/shell_exec.
11. Extension: MV3, minimal permissions, host_permissions localhost
    only, content script extracts meta tags on demand only.
12. CI: no secrets, localhost checks only.
13. Lockfile: every package.json dep resolves in pnpm-lock.yaml;
    registry default npm; sole odd URL tsx.is (legit). No typosquats.

## Risks / notes (not malware)

0. Custom AI providers (added after the c520ea0 audit): users can
   register arbitrary OpenAI-compatible base URLs
   (`ai.custom_providers` settings row) and the server will POST chat
   traffic there — an intentional, user-directed egress, same trust
   model as the existing Ollama URL setting (user-controlled
   localhost URL, no SSRF guard) and the WP scan target field.
   Mitigations: http/https schemes only (normalizeBaseUrl rejects
   everything else — no file:, no ftp:); requests carry no tool data
   beyond the prompt the user's action already built; API keys are
   encrypted at rest (crypto.ts enc:v1) and stripped from all client
   payloads via toPublicMeta. NOT mitigated: a user could point a
   custom provider at an internal service — accepted because the
   threat actor is the single local user who already owns the machine
   (localhost-bind app, auth-gated settings).

1. `.npmrc`: `dangerously-allow-all-builds=true` +
   `auto-approve-builds=true` — every dep postinstall runs unprompted.
   Mitigated by pnpm-workspace.yaml allowlist (better-sqlite3, esbuild,
   msw, sharp, tesseract.js, unrs-resolver) but pnpm 11 honors the broad
   override, defeating the gate. Biggest supply-chain exposure. Fix:
   delete the two broad lines, keep allowlists in package.json +
   pnpm-workspace.yaml.
2. In-app updater force-syncs to upstream IamRamgarhia/SEO-Tool and runs
   `pnpm install` — future upstream commits execute locally after
   "Update now". Inherent to design. Also note fork vs upstream
   divergence: origin is the user's fork; ff-pull may fail and trigger
   force-sync against origin/main.
3. xlsx@0.18.5 (devDep) — historical prototype-pollution/ReDoS
   advisories; SheetJS moved off npm. Dev-only, low risk.
4. Updater runs `git clean -fd` + `reset --hard` on dirty trees — wipes
   untracked non-gitignored files. data.db/.env.local/.seo-* are
   gitignored and preserved.
5. APP_PASSWORD unset + deliberate 0.0.0.0 bind: admin endpoints rely on
   the local-request check only. Fine for loopback default; know the
   tradeoff before exposing.

## Staleness re-check (run when HEAD != c520ea0)

```bash
git status --porcelain                    # clean?
git log --oneline c520ea0..HEAD          # what's new
# quick pattern sweep on NEW commits only:
git diff c520ea0..HEAD | grep -E '^\+' | grep -nE \
  'eval\(|new Function\(|base64 -d|FromBase64|certutil|Invoke-Expression|child_process|os\.system'
# re-grep outbound hosts on changed src files; re-check .npmrc,
# pnpm-workspace.yaml allowlist, .github/workflows, install.sh|ps1 URLs
```

If update touches package.json / .npmrc / installers / auth / updater:
re-audit those fully.

# 01 — Project overview

## What it is

All-In-One-Free-SEO-Tool — open-source, self-hosted SEO suite positioned
as a free alternative to Ahrefs/Semrush/Moz/SE Ranking. Site audits, rank
tracking, keyword research, AI visibility (ChatGPT/Perplexity/Gemini
citations), content briefs, backlink analysis, local SEO, white-label
client reports, automations, WordPress bridge, MCP server. Works with
free AI keys (Gemini, Groq); no paid APIs required.

- Upstream repo: https://github.com/IamRamgarhia/SEO-Tool
- License: MIT. Author: DiceCodes / Prince Ramgarhia (IamRamgarhia).
- Local clone at c520ea0 (2026-09-10) sits on origin
  https://github.com/mahdi-sheibak/All-In-One-Free-SEO-Tool (user's fork).

## Stack

- Next.js 16.2.4 (App Router, standalone output, Turbopack-era — NOT the
  Next.js in older training data; see docs/AGENTS.md note)
- React 19.2.4, Tailwind 4, shadcn-style UI (@base-ui/react), recharts
- DB: SQLite via better-sqlite3 + drizzle-orm (64 SQL migrations in
  src/db/migrations), file `data.db` (or $SEO_DB_PATH)
- Scraping/rank checks: Playwright (Chromium)
- PDF: pdfkit; icons: @resvg/resvg-js + satori; OCR: tesseract.js
- Email: nodemailer; xlsx export (devDep)
- Package manager: pnpm 10/11 aware (config duplicated in package.json +
  pnpm-workspace.yaml — they MUST stay in sync, see .npmrc comment)
- Tests: vitest (unit), Playwright (e2e in e2e/)
- Node >= 20.11

## Commands

- `pnpm run dev` — dev server (runs migrate.cjs first via predev)
- `pnpm run build` / `pnpm start` — production build/serve
- `pnpm run lint` — eslint
- `pnpm run typecheck` — tsc --noEmit
- `pnpm run test` — vitest run
- `pnpm run test:e2e` — Playwright
- `pnpm run db:generate` — drizzle-kit generate (migrations)
- `pnpm run mcp` — stdio MCP server (scripts/mcp-server.ts)
- `pnpm run setup` — migrate + build + playwright install chromium

## Runtime shape

Local-first desktop-style app. Launchers in bin/ (START/STOP/seo + .cmd
variants) and one-line installers (install.sh, install.ps1) target
non-technical self-hosters. Default bind is 127.0.0.1. Auth has three
modes (see src/middleware.ts): accounts (registered users, supersedes
everything), shared APP_PASSWORD, or open (local dev default).

State lives next to the code or in $SEO_DATA_DIR: data.db,
.seo-encryption-key (AES-256-GCM for stored provider tokens),
.seo-port, .seo-session-secret — all gitignored and preserved by the
updater.

## Self-update mechanism (important)

In-app `/api/update` (src/app/api/update/route.ts) and CLI
`bin/seo-update.cjs` fetch upstream GitHub, `git pull --ff-only`, and on
dirty trees fall back to `git clean -fd` + `git reset --hard origin/main`,
then `pnpm install` if package.json changed, then migrations. Do not keep
untracked non-gitignored files in the install dir.

## Scale

~1,223 tracked files, ~200k lines (TS/TSX dominant), 237 commits,
single-author project. docs/ contains AGENTS.md (Next.js version
warning), HOSTING.md, ROADMAP.md, TROUBLESHOOTING.md, screenshots.

# AGENT.md

Instructions for AI coding agents working in this repo.

## Start here

Before analyzing the codebase, read the `.agent/` docs (short, current):

1. `.agent/README.md` — protocol + ground rules
2. `.agent/01-project-overview.md` — stack, commands, auth model
3. `.agent/03-codebase-map.md` — annotated map + gotchas
4. `.agent/02-security-audit.md` — audit verdict + risks (check
   staleness against HEAD first; audited at c520ea0, 2026-09-10)

Go into the code for whatever your task touches after that. Do not
re-audit the whole repo per session.

## Verified facts (don't re-derive)

- Stack: Next.js 16.2.4 + React 19, better-sqlite3 via drizzle (64 SQL
  migrations), Playwright for scraping, pnpm. Node >= 20.11.
- Local-first self-hosted app. Default bind 127.0.0.1. Auth: accounts >
  APP_PASSWORD > open (src/middleware.ts).
- Codebase audited for malicious code at c520ea0: CLEAN. No telemetry,
  no exfiltration, no obfuscation. See .agent/02-security-audit.md for
  residual risks before changing .npmrc, update code, or auth.
- src/app/api/restore/route.ts greps as binary (literal NUL in the
  SQLite magic string). Benign — do not "fix" the file blindly.
- Next.js 16 has breaking changes vs older training data. Read
  docs/AGENTS.md and node_modules/next/dist/docs/ when writing
  Next-specific code.

## Workflow rules

- Verify with: `pnpm run lint && pnpm run typecheck && pnpm run test`.
  Build: `pnpm run build`. E2E: `pnpm run test:e2e` (needs browsers).
- Migrations: drizzle-kit generate → files land in src/db/migrations/
  → applied by scripts/migrate.cjs. Never hand-edit applied migrations;
  add a new SQL file.
- pnpm allowlists exist in BOTH package.json (`pnpm.onlyBuiltDependencies`)
  and pnpm-workspace.yaml — keep them in sync. .npmrc intentionally
  bypasses pnpm's build gate; do not edit casually (audit risk #1).
- Touch only what the task needs. No drive-by refactors or reformatting.
- Do not commit/push unless asked. Do not read real secret values
  (.env.local / docker env); .env.example is template-only.
- The app self-updates via force-sync to GitHub — never test
  /api/update, /api/restore, /api/restart against a directory holding
  untracked work.
- Match existing style: heavy explanatory comments are the house style
  (see src/lib/admin-auth.ts for the tone). TypeScript strict.

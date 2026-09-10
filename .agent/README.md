# .agent — agent onboarding docs (read FIRST)

Purpose: let any fresh AI session become productive without re-analyzing
the whole repo. Read these files first, then go into the codebase only
for what changed or what the task actually touches.

## Reading order

1. `README.md` — this file (protocol + index)
2. `01-project-overview.md` — what this project is, stack, commands
3. `03-codebase-map.md` — annotated directory/file map, gotchas
4. `02-security-audit.md` — full audit report (dated; check staleness)

## Fresh-session protocol

1. Read 01 and 03 fully. Skim 02 verdict + risks.
2. Check staleness of the audit:
   `git rev-parse --short HEAD` — audit was done at commit `c520ea0`
   (2026-09-10). If HEAD differs, re-run the quick checks listed at the
   end of `02-security-audit.md` before trusting its conclusions.
3. Only then analyze code directly — and only the parts your task needs.
   Do not re-audit the whole repo per session.
4. Update these docs when you learn something durable (new subsystem,
   new risk, changed conventions). Keep them short.

## Ground rules for agents in this repo

- Do not commit, push, or rewrite history unless the user explicitly asks.
- Do not run `pnpm install` / builds / docker unless the task requires it;
  the user often runs final side-effect commands himself.
- Never read/print `.env*` real values (only `.env.example` exists and it
  is template-only — verified).
- `.npmrc` here intentionally disables pnpm's build-script gate. Do not
  "fix" it casually — see `02-security-audit.md` risk #1 first.
- The app self-updates by force-syncing to the GitHub upstream repo.
  Understand `02-security-audit.md` risk #2 before touching update code.
- Next.js here is v16 with breaking changes vs older training data.
  See the injected note in `docs/AGENTS.md`; consult
  `node_modules/next/dist/docs/` when writing Next-specific code.

## Index

| File | Content |
|---|---|
| `01-project-overview.md` | Product, stack, commands, auth model, runtime |
| `02-security-audit.md` | Full malicious-code audit, verdict, risks, re-audit steps |
| `03-codebase-map.md` | Directory map, key files with one-liners, gotchas |

/**
 * Task 6.2 — manual verification checklist, executed as a script.
 *
 * The Playwright suite covers the nav shell + tools smoke, NOT
 * settings flows (verified: zero settings-flow specs in e2e/), so the
 * tasks.md fallback is this checklist. It drives the REAL server
 * modules (settings-store → api-keys → dispatch → ai-usage) against a
 * THROWAWAY SQLite DB under /tmp — never the developer's data.db.
 *
 * Run with: npx tsx scripts/custom-providers-checklist.ts
 * (tsx so the modules' `@/` import aliases resolve.)
 *
 * Checklist (from tasks.md):
 *   1. add local LM Studio provider   → saveCustomProviders
 *   2. activate it                    → ai.active_provider setting
 *   3. run a tool that uses AI        → dispatchProviderCall (fetch mocked)
 *   4. usage log shows custom:<slug>  → ai_calls row via the ai-usage path
 */
import { rmSync, mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";

// Env MUST be set before the first dynamic import below — db/client.ts
// reads SEO_DB_PATH at module scope.
process.env.SEO_DB_PATH = "/tmp/custom-providers-checklist/checklist.db";
process.env.SEO_DATA_DIR = "/tmp/custom-providers-checklist";
// Deterministic 32-byte test key (base64) so encrypt/decrypt works
// outside the interactive setup flow.
process.env.SEO_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

async function main() {
  // Fresh throwaway DB every run.
  rmSync("/tmp/custom-providers-checklist", { recursive: true, force: true });
  mkdirSync("/tmp/custom-providers-checklist", { recursive: true });

  // migrate.cjs applies schema on import (top-level side effect).
  await import("../scripts/migrate.cjs");

  // Dynamic imports: every one of these transitively opens the DB, so
  // they must evaluate AFTER the env block above (static imports hoist
  // and would run first).
  const store = await import("@/lib/settings-store");
  const apiKeys = await import("@/lib/api-keys");
  const dispatch = await import("@/lib/provider-dispatch");
  const cp = await import("@/lib/custom-providers");
  const { db } = await import("@/db/client");
  const { aiCalls } = await import("@/db/schema");

  const results: { name: string; ok: boolean }[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok });
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
    );
  };

  // --- 1. Add local LM Studio provider (keyless: local endpoint) ---
  const slug = cp.slugifyProviderLabel("LM Studio");
  // as const: template literal with a string hole widens to string —
  // pin it to the CustomProviderId shape the store API expects.
  const id = `custom:${slug}` as const;
  await store.saveCustomProviders([
    {
      id,
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen2.5-7b-instruct",
      apiKey: "", // keyless local endpoint
    },
  ]);
  const saved = await store.getCustomProviders();
  check(
    "1. custom provider saved",
    saved.length === 1 && saved[0].id === id,
    JSON.stringify(saved[0]),
  );

  // --- 2. Activate it ---
  await store.setSetting("ai.active_provider", id);
  const active = await apiKeys.getActiveProvider();
  // Checklist precondition: activation must leave a non-null active id.
  if (!active)
    throw new Error("getActiveProvider returned null after setSetting");
  check("2. custom provider active", active === id, `active=${active}`);

  const cfg = await apiKeys.configuredProviders();
  check(
    "2b. configuredProviders includes custom",
    cfg.ids.includes(id) && cfg.byId[id] === true,
  );

  // --- 3. Run a tool that uses AI (dispatch path, fetch mocked) ---
  const calls: { url: string; headers: unknown }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "mock reply" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const reply = await dispatch.dispatchProviderCall(active, {
    system: "You are a test.",
    user: "Say hi",
    maxTokens: 100,
    temperature: 0.2,
    timeoutMs: 5_000,
    caller: "checklist",
  });
  check(
    "3. dispatch reaches custom endpoint",
    reply === "mock reply",
    `url=${calls[0]?.url}`,
  );
  check(
    "3b. keyless request sends NO authorization header",
    calls.length === 1 &&
      !JSON.stringify(calls[0].headers).toLowerCase().includes("authorization"),
  );

  // --- 4. Usage log shows custom:<slug> (via the real ai-usage path) ---
  const { logAiCall } = await import("@/lib/ai-usage");
  await logAiCall({
    feature: "checklist",
    provider: active,
    model: "qwen2.5-7b-instruct",
    promptText: "Say hi",
    completionText: "mock reply",
    promptTokens: 120,
    completionTokens: 45,
    latencyMs: 12,
    status: "ok",
  });
  const rows = await db.select().from(aiCalls).where(eq(aiCalls.provider, id));
  check(
    "4. usage log records custom:<slug>",
    rows.length === 1 && rows[0].model === "qwen2.5-7b-instruct",
    `provider=${rows[0]?.provider} model=${rows[0]?.model}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("checklist crashed:", err);
  process.exit(1);
});

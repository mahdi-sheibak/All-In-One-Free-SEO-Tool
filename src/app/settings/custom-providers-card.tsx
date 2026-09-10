"use client";

import { useState, useTransition } from "react";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Check,
  Save,
  Plug,
  X,
} from "lucide-react";
import { deleteCustomProvider, saveCustomProvider } from "./key-actions";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { safeFetch } from "@/lib/safe-fetch";
import type { CustomProviderPublicMeta } from "@/lib/custom-providers";

/**
 * Custom OpenAI-compatible providers card (Settings → AI provider keys).
 *
 * CRUD over ai.custom_providers through key-actions.ts — the server
 * action owns every validation rule (scheme, required fields, key
 * encryption), so this form is convenience only and a crafted request
 * can't persist anything the action would reject.
 *
 * Secret handling: the plaintext key field is write-only. On edit we
 * seed label/baseUrl/model but NEVER the key; a blank key field means
 * "keep the stored key", and the "no API key" checkbox (sent as
 * clearKey=1) explicitly drops it for keyless local endpoints. The
 * masked `••••` chip is computed from hasKey, which the server derives
 * without ever exposing the secret.
 */

type TestResult =
  | { ok: true; reply: string; elapsedMs: number }
  | { ok: false; error: string };

export function CustomProvidersCard({
  customProviders,
  activeProvider,
}: {
  customProviders: CustomProviderPublicMeta[];
  activeProvider: string | null;
}) {
  const [pending, startTransition] = useTransition();
  // "new" ⇒ add-form open; a provider id ⇒ edit-form open for that row.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({
    label: "",
    baseUrl: "",
    model: "",
    apiKey: "",
  });
  // Edit-mode view of the stored key state: checkbox off = keep stored
  // key (or add one), on = endpoint is keyless (sends clearKey=1).
  const [keyless, setKeyless] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>(
    {},
  );

  const openAdd = () => {
    setEditing("new");
    setForm({ label: "", baseUrl: "", model: "", apiKey: "" });
    setKeyless(false);
    setError(null);
  };

  const openEdit = (cp: CustomProviderPublicMeta) => {
    setEditing(cp.id);
    // Seed everything except the secret — it must never round-trip
    // back to the browser.
    setForm({
      label: cp.label,
      baseUrl: cp.baseUrl,
      model: cp.model,
      apiKey: "",
    });
    setKeyless(!cp.hasKey);
    setError(null);
  };

  const closeForm = () => {
    setEditing(null);
    setError(null);
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (editing && editing !== "new") fd.set("id", editing);
    if (keyless) fd.set("clearKey", "1");
    setError(null);
    startTransition(async () => {
      const r = await saveCustomProvider(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSavedId(r.id);
      setTimeout(() => setSavedId(null), 1800);
      closeForm();
    });
  };

  const handleDelete = async (cp: CustomProviderPublicMeta) => {
    const ok = await confirmDialog({
      title: `Remove ${cp.label}?`,
      description:
        "Existing usage-log rows keep their provider id. If it was the active AI provider, the app falls back to the first configured provider.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    startTransition(async () => {
      await deleteCustomProvider(cp.id);
    });
  };

  const runTest = async (id: string) => {
    setTesting(id);
    setTestResults((m) => ({ ...m, [id]: { ok: false, error: "" } }));
    const r = await safeFetch<TestResult>("/api/test-provider", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: id }),
    });
    setTestResults((m) => ({
      ...m,
      [id]: r.ok ? r.data : { ok: false, error: r.error },
    }));
    setTesting(null);
  };

  return (
    <div
      id="provider-custom"
      className="scroll-mt-20 rounded-xl border border-white/5 bg-black/20 backdrop-blur"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div>
          <div className="flex items-center gap-2 font-medium">
            <Plug className="size-3.5 text-violet-300" />
            Custom OpenAI-compatible endpoints
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            LM Studio, llama.cpp, vLLM, LiteLLM — anything speaking the OpenAI
            chat-completions format. Base URL like{" "}
            <code className="text-violet-300">http://localhost:1234/v1</code>;
            the app appends{" "}
            <code className="text-violet-300">/chat/completions</code>.
          </p>
        </div>
        {editing === "new" ? (
          <button
            type="button"
            onClick={closeForm}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-white/[0.04]"
          >
            <X className="size-3" /> Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={openAdd}
            className="inline-flex items-center gap-1 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-500/20"
          >
            <Plus className="size-3" /> Add custom provider
          </button>
        )}
      </div>

      {/* Inline add/edit form — opened in place, never a modal, so the
          user keeps context with the cards above/below. */}
      {editing && (
        <form
          onSubmit={handleSubmit}
          className="space-y-3 border-b border-white/5 px-4 py-4"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">
                Display name
              </span>
              <input
                name="label"
                value={form.label}
                onChange={(e) =>
                  setForm((f) => ({ ...f, label: e.target.value }))
                }
                placeholder="LM Studio (my machine)"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-violet-500/50"
                autoFocus
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">
                Base URL{" "}
                <span className="text-amber-300">(http/https only)</span>
              </span>
              <input
                name="baseUrl"
                type="url"
                value={form.baseUrl}
                onChange={(e) =>
                  setForm((f) => ({ ...f, baseUrl: e.target.value }))
                }
                placeholder="http://localhost:1234/v1"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-violet-500/50"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">
                Model id <span className="text-amber-300">(required)</span>
              </span>
              <input
                name="model"
                value={form.model}
                onChange={(e) =>
                  setForm((f) => ({ ...f, model: e.target.value }))
                }
                placeholder="qwen2.5-7b-instruct"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-violet-500/50"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">
                API key{" "}
                <span className="text-muted-foreground/70">
                  (optional — local servers usually need none)
                </span>
              </span>
              <input
                name="apiKey"
                type="password"
                value={form.apiKey}
                onChange={(e) =>
                  setForm((f) => ({ ...f, apiKey: e.target.value }))
                }
                disabled={keyless}
                placeholder={
                  keyless
                    ? "Endpoint needs no key"
                    : "sk-… (leave blank to keep current)"
                }
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-violet-500/50 disabled:opacity-50"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={keyless}
              onChange={(e) => setKeyless(e.target.checked)}
              className="size-3.5 accent-violet-500"
            />
            This endpoint needs no API key (sends no Authorization header)
          </label>

          {error && (
            <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
            >
              {pending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Save className="size-3" />
              )}
              {editing === "new" ? "Add provider" : "Save changes"}
            </button>
            {editing !== "new" && (
              <button
                type="button"
                onClick={closeForm}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-muted-foreground hover:bg-white/[0.04]"
              >
                Cancel
              </button>
            )}
            <span className="text-[11px] text-muted-foreground/70">
              Keys are encrypted at rest, like every built-in provider key.
            </span>
          </div>
        </form>
      )}

      {customProviders.length === 0 ? (
        <p className="px-4 py-4 text-xs text-muted-foreground">
          No custom providers yet. Add one to use a local model or a non-catalog
          gateway alongside the built-ins above.
        </p>
      ) : (
        <div className="divide-y divide-white/5">
          {customProviders.map((cp) => {
            const isActive = activeProvider === cp.id;
            const tr = testResults[cp.id];
            return (
              <div key={cp.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{cp.label}</span>
                  {/* Masked key state — derived server-side from hasKey;
                      the secret itself never leaves the database. */}
                  <span
                    className={
                      cp.hasKey
                        ? "rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-emerald-300 ring-1 ring-inset ring-emerald-500/30"
                        : "rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-muted-foreground ring-1 ring-inset ring-white/10"
                    }
                  >
                    {cp.hasKey ? "•••• SAVED" : "NO KEY"}
                  </span>
                  {isActive && (
                    <span className="rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-violet-300 ring-1 ring-inset ring-violet-500/30">
                      ACTIVE
                    </span>
                  )}
                  {savedId === cp.id && (
                    <Check className="size-3.5 text-emerald-400" />
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => runTest(cp.id)}
                      disabled={testing !== null}
                      className="rounded-lg border border-white/10 px-2 py-1 text-[11px] text-muted-foreground hover:bg-white/[0.04] disabled:opacity-50"
                    >
                      {testing === cp.id ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        "Test"
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(cp)}
                      className="rounded-lg border border-white/10 px-2 py-1 text-[11px] text-muted-foreground hover:bg-white/[0.04]"
                      title="Edit"
                    >
                      <Pencil className="size-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(cp)}
                      disabled={pending}
                      className="rounded-lg border border-red-500/20 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                      title="Remove"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </span>
                </div>
                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                  {cp.baseUrl}/chat/completions · model <code>{cp.model}</code>
                </p>
                {tr && !tr.ok && tr.error && (
                  <p className="mt-1 text-[11px] text-red-300">{tr.error}</p>
                )}
                {tr && tr.ok && (
                  <p className="mt-1 text-[11px] text-emerald-300">
                    Connected — {tr.reply} ({tr.elapsedMs}ms)
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

"use server";

import { configuredProviders, getActiveProvider } from "@/lib/api-keys";
import { getCustomProviders } from "@/lib/settings-store";
import {
 toPublicMeta,
 type CustomProviderPublicMeta,
} from "@/lib/custom-providers";
import type { ActiveProvider } from "@/lib/api-keys";

export type ProviderListing = {
 configured: ActiveProvider[];
 active: ActiveProvider | null;
 /**
  * Public metadata for every configured custom provider — label, saved
  * model, and hasKey instead of key material. The client model picker
  * feeds this into ai-model-presets' runtime seed so custom ids get
  * real labels and defaults in the browser (the server's module-level
  * cache does not transfer across the RSC boundary).
  */
 customProviders: CustomProviderPublicMeta[];
};

/**
 * Returns the providers the user can dispatch to (catalog keys + Ollama
 * + saved custom endpoints), plus which one is currently the workspace
 * default. Safe to call from any client component — no key material is
 * ever exposed.
 */
export async function listConfiguredProviders(): Promise<ProviderListing> {
 const cfg = await configuredProviders();
 const active = await getActiveProvider();
 const customs = await getCustomProviders();
 return {
  configured: cfg.ids,
  active,
  customProviders: toPublicMeta(customs),
 };
}

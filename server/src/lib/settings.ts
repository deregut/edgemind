/** Typed access to the key/value `settings` table (non-secret values). */
import { eq } from "drizzle-orm";
import type { AgentSettingsDTO, FullModeCaps } from "@edgemind/shared";
import type { Database } from "../db/client";
import { settings } from "../db/schema";

export async function getSetting<T = unknown>(database: Database, key: string): Promise<T | undefined> {
  const [row] = await database.db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return (row?.value ?? undefined) as T | undefined;
}

export async function setSetting(database: Database, key: string, value: unknown): Promise<void> {
  await database.db
    .insert(settings)
    .values({ key, value: value as object })
    .onConflictDoUpdate({ target: settings.key, set: { value: value as object, updatedAt: new Date() } });
}

export const DEFAULT_MAX_STEPS = 25;
export const DEFAULT_FULL_CAPS: FullModeCaps = { maxSteps: 50, maxTokens: 2_000_000, maxCostUsd: null };

const posNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export function normalizeCaps(v: any): FullModeCaps {
  if (!v || typeof v !== "object") return { ...DEFAULT_FULL_CAPS };
  return {
    maxSteps: posNum(v.maxSteps) !== null ? Math.floor(v.maxSteps) : null,
    maxTokens: posNum(v.maxTokens) !== null ? Math.floor(v.maxTokens) : null,
    maxCostUsd: posNum(v.maxCostUsd),
  };
}

export async function getFullModeCaps(database: Database): Promise<FullModeCaps> {
  const v = await getSetting(database, "full_mode_caps");
  return v === undefined ? { ...DEFAULT_FULL_CAPS } : normalizeCaps(v);
}

export type ModelPrices = AgentSettingsDTO["modelPrices"];

export async function getModelPrices(database: Database): Promise<ModelPrices> {
  const v = await getSetting<ModelPrices>(database, "model_prices");
  return v && typeof v === "object" ? v : {};
}

export { costOf } from "../usage";

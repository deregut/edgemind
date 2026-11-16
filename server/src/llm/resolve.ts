/**
 * Builds an LlmConfig from saved settings: providers row (decrypted key, base URL, config fields) + models row
 * (capability flags). Used by the agent loop.
 */
import { and, eq } from "drizzle-orm";
import type { LlmProtocol, ModelCapabilities } from "../../../shared/src/index";
import { getKindSpec } from "../../../shared/src/index";
import type { Database } from "../db/client";
import { models, providers } from "../db/schema";
import { decryptSecret } from "../lib/crypto";
import type { Fetch } from "./http";
import { LlmError } from "./http";
import type { LlmConfig } from "./types";

/** Parse "Name: value" lines (or a JSON object) into headers. Invalid header names are ignored. */
export function parseExtraHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const out: Record<string, string> = {};
  const valid = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const t = raw.trim();
  if (t.startsWith("{")) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(t))) if (valid.test(k) && typeof v === "string") out[k.toLowerCase()] = v;
      return out;
    } catch {
      return {};
    }
  }
  for (const line of t.split(/\r?\n|\\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (valid.test(k)) out[k.toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

export interface ResolvedModel {
  cfg: LlmConfig;
  /** The provider's model id string (e.g. "gpt-4.1"). */
  model: string;
  modelRowId: string;
  providerId: string;
  contextLength: number | null;
}

export function configFromRows(
  provider: { kind: string; baseUrl: string; config: Record<string, string> | null },
  apiKey: string | null,
  capabilities: ModelCapabilities,
  fetchImpl?: Fetch,
): LlmConfig {
  const conf = provider.config ?? {};
  const protocol = provider.kind as LlmProtocol;
  return {
    protocol,
    baseUrl: provider.baseUrl || getKindSpec("llm", provider.kind)?.defaultBaseUrl || "",
    apiKey,
    headers: parseExtraHeaders(conf.extraHeaders),
    openaiApi: conf.api === "responses" ? "responses" : "chat",
    streamUsage: conf.streamUsage !== "false",
    replayReasoningContent: conf.replayReasoning === "true",
    capabilities,
    fetch: fetchImpl,
  };
}

export async function resolveModel(database: Database, encKey: Uint8Array, modelRowId: string, fetchImpl?: Fetch): Promise<ResolvedModel> {
  const [row] = await database.db
    .select({ m: models, p: providers })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.id, modelRowId)))
    .limit(1);
  if (!row) throw new LlmError({ message: "找不到指定的模型", code: "model_not_found" });
  if (row.p.type !== "llm") throw new LlmError({ message: "此供應商不是語言模型", code: "bad_provider" });
  if (!row.p.enabled || !row.m.enabled) throw new LlmError({ message: "模型或供應商已停用", code: "disabled" });
  const apiKey = row.p.apiKeyEnc ? await decryptSecret(row.p.apiKeyEnc, encKey, `provider:${row.p.id}:apiKey`) : null;
  return {
    cfg: configFromRows(row.p, apiKey, row.m.capabilities as ModelCapabilities, fetchImpl),
    model: row.m.modelId,
    modelRowId: row.m.id,
    providerId: row.p.id,
    contextLength: row.m.contextLength,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `id` if it names a chat model that can be used right now (row exists, enabled, on an enabled LLM provider), else null.
 * Model references kept in `settings` (default_model_id, title_model_id) have no foreign key: re-syncing a provider's
 * model list, deleting a provider or disabling a model leaves them pointing at nothing, so always read them through this.
 */
export async function usableModelId(database: Database, id: unknown): Promise<string | null> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const [row] = await database.db
    .select({ id: models.id })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.id, id), eq(models.enabled, true), eq(providers.enabled, true), eq(providers.type, "llm")))
    .limit(1);
  return row?.id ?? null;
}

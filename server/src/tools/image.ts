/**
 * image_generate [write, projectOnly]: generates one image with the first enabled image provider (priority order)
 * and saves it as a project file. Dialects: OpenAI-compatible /images/generations, Gemini generateContent (image
 * modality), Cloudflare Workers AI (REST or `env.AI` binding). Native fetch only.
 */
import { and, asc, eq } from "drizzle-orm";
import { getKindSpec } from "@edgemind/shared";
import type { Tool, ToolContext } from "../agent/tools";
import { models, providers, usageLogs } from "../db/schema";
import { decryptSecret } from "../lib/crypto";
import { normalizePath } from "../storage/files";
import { trimSlash, type ProbeTarget } from "../providers/probe";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49) return "image/webp";
  return "image/png";
}

async function post(ctx: ToolContext, url: string, headers: Record<string, string>, body: unknown, apiKey: string | null): Promise<any> {
  const res = await ctx.fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctx.signal });
  const text = await res.text();
  if (!res.ok) {
    let m = text.slice(0, 300);
    if (apiKey) m = m.split(apiKey).join("***");
    throw new Error(`圖片供應商回應 HTTP ${res.status}：${m}`);
  }
  try { return JSON.parse(text); } catch { throw new Error("圖片供應商回應不是有效的 JSON"); }
}

export async function generateImage(ctx: ToolContext, t: ProbeTarget, model: string, prompt: string, size?: string): Promise<Uint8Array> {
  const base = trimSlash(t.baseUrl || getKindSpec("image", t.kind)?.defaultBaseUrl || "");
  if (t.kind === "openai") {
    const body: Record<string, unknown> = { model, prompt, n: 1 };
    if (size) body.size = size;
    const j = await post(ctx, `${base}/images/generations`, t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {}, body, t.apiKey);
    const d = j?.data?.[0];
    if (d?.b64_json) return b64ToBytes(d.b64_json);
    if (d?.url) {
      const r = await ctx.fetch(d.url, { signal: ctx.signal });
      if (!r.ok) throw new Error(`下載生成圖片失敗 HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    }
    throw new Error("供應商沒有回傳圖片");
  }
  if (t.kind === "gemini") {
    const j = await post(ctx, `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": t.apiKey ?? "" },
      { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }, t.apiKey);
    for (const p of j?.candidates?.[0]?.content?.parts ?? []) {
      const d = p.inlineData ?? p.inline_data;
      if (d?.data) return b64ToBytes(d.data);
    }
    throw new Error("Gemini 沒有回傳圖片（模型可能不支援圖片輸出或被安全機制擋下）");
  }
  if (t.kind === "workers_ai") {
    let j: any;
    if (ctx.ai) j = await ctx.ai.run(model, { prompt });
    else j = (await post(ctx, `${base}/accounts/${encodeURIComponent(t.config.accountId)}/ai/run/${model}`, { authorization: `Bearer ${t.apiKey}` }, { prompt }, t.apiKey))?.result;
    const b64 = typeof j === "string" ? j : j?.image;
    if (typeof b64 === "string") return b64ToBytes(b64);
    throw new Error("Workers AI 沒有回傳圖片");
  }
  throw new Error(`不支援的圖片供應商：${t.kind}`);
}

export const imageGenerateTool: Tool = {
  name: "image_generate",
  description: "用已設定的圖片生成供應商產生一張圖片，並存成專案檔案（預設 images/ 資料夾）。回傳檔案路徑。",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "圖片描述" },
      path: { type: "string", description: "儲存路徑，例如 images/cat.png；省略則自動命名" },
      size: { type: "string", description: "尺寸（OpenAI 相容才有效），如 1024x1024" },
    },
    required: ["prompt"],
  },
  risk: "write",
  projectOnly: true,
  nonIdempotent: true,
  async execute(args, ctx) {
    const prompt = String(args?.prompt ?? "").trim();
    if (!prompt) throw new Error("請提供 prompt");
    if (!ctx.storage || !ctx.projectId) throw new Error("只能在專案內產生圖片");
    const rows = await ctx.database.db.select({ m: models, p: providers }).from(providers)
      .leftJoin(models, and(eq(models.providerId, providers.id), eq(models.enabled, true)))
      .where(and(eq(providers.type, "image"), eq(providers.enabled, true)))
      .orderBy(asc(providers.priority), asc(providers.createdAt));
    const pick = rows.find((r) => r.m) ?? rows[0];
    if (!pick) throw new Error("尚未設定圖片生成供應商（設定 → 供應商 → 圖片生成）");
    const model = pick.m?.modelId ?? getKindSpec("image", pick.p.kind)?.suggestedModels?.[0];
    if (!model) throw new Error("圖片供應商沒有可用的模型，請先在設定中啟用一個");
    const apiKey = pick.p.apiKeyEnc ? await decryptSecret(pick.p.apiKeyEnc, ctx.encKey, `provider:${pick.p.id}:apiKey`) : null;
    const target: ProbeTarget = { type: "image", kind: pick.p.kind, baseUrl: pick.p.baseUrl, apiKey, config: pick.p.config ?? {} };
    const bytes = await generateImage(ctx, target, model, prompt, typeof args?.size === "string" ? args.size : undefined);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("生成的圖片超過 5 MB");
    const mime = sniffMime(bytes);
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    const path = normalizePath(typeof args?.path === "string" && args.path ? args.path : `images/${Date.now().toString(36)}.${ext}`);
    const row = await ctx.storage.write(ctx.projectId, path, bytes, mime, ctx.conversationId);
    await ctx.database.db.insert(usageLogs).values({ providerId: pick.p.id, model, runId: ctx.runId, kind: "image" }).catch(() => {});
    return { path: row.path, mime, size: bytes.length, model };
  },
};

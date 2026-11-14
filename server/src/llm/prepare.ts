/**
 * Provider-independent request normalization driven by model capability flags:
 *  - no vision  → image parts become a short text note
 *  - file parts → extracted text inlined; PDFs kept only with `pdf` capability; images → image parts
 *  - no tools   → tools dropped and past tool_call/tool_result parts flattened to text
 *  - reasoning parts from another protocol (signatures would be rejected) are dropped
 *  - no reasoning capability → request.reasoning removed
 */
import type { ChatRequest, LlmProtocol, Message, ModelCapabilities, Part } from "@edgemind/shared";
import { resultToString } from "./types";

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh|sql|csv))/;

export function decodeBase64Text(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function normalizePart(p: Part, caps: ModelCapabilities, protocol: LlmProtocol): Part[] {
  switch (p.type) {
    case "image":
      if (caps.vision === false) return [{ type: "text", text: "[圖片未傳送：此模型不支援視覺輸入]" }];
      return [p];
    case "file": {
      if (p.text !== undefined) return [{ type: "text", text: `[檔案：${p.name}]\n${p.text}` }];
      if (p.mime.startsWith("image/") && (p.data || p.url)) {
        return normalizePart({ type: "image", mime: p.mime, data: p.data, url: p.url }, caps, protocol);
      }
      if (p.data && TEXT_MIME.test(p.mime)) return [{ type: "text", text: `[檔案：${p.name}]\n${decodeBase64Text(p.data)}` }];
      if (p.mime === "application/pdf" && p.data && caps.pdf) return [p];
      return [{ type: "text", text: `[附件：${p.name}（${p.mime}），內容未直接提供給模型]` }];
    }
    case "reasoning": {
      const owner = p.providerMeta?.protocol;
      if (owner && owner !== protocol) return [];
      return [p];
    }
    default:
      return [p];
  }
}

function flattenTools(m: Message): Message {
  const parts: Part[] = m.parts.map((p): Part => {
    if (p.type === "tool_call") return { type: "text", text: `[呼叫工具 ${p.name}：${resultToString(p.args)}]` };
    if (p.type === "tool_result") return { type: "text", text: `[工具 ${p.name} 結果${p.isError ? "（錯誤）" : ""}：${resultToString(p.result)}]` };
    return p;
  });
  return { role: m.role === "tool" ? "user" : m.role, parts };
}

export function prepareRequest(req: ChatRequest, caps: ModelCapabilities, protocol: LlmProtocol): ChatRequest {
  let messages = req.messages.map((m) => ({ role: m.role, parts: m.parts.flatMap((p) => normalizePart(p, caps, protocol)) }));
  const out: ChatRequest = { ...req, messages };
  if (caps.tools === false) {
    delete out.tools;
    delete out.toolChoice;
    delete out.parallelToolCalls;
    messages = messages.map(flattenTools);
    out.messages = messages;
  }
  if (!out.tools?.length) {
    delete out.tools;
    delete out.toolChoice;
    delete out.parallelToolCalls;
  }
  if (!caps.reasoning) delete out.reasoning;
  // Drop messages that became empty (e.g. only foreign reasoning).
  out.messages = out.messages.filter((m) => m.parts.length > 0);
  return out;
}

/** Effort → token budget for budget-based thinking (Anthropic / Gemini). */
export function effortBudget(effort: string | undefined, explicit?: number): number {
  if (explicit && explicit > 0) return explicit;
  switch (effort) {
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "high":
      return 24576;
    default:
      return 8192;
  }
}

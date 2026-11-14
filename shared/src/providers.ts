// Provider catalog shared by server (validation, defaults) and web (forms).

export const PROVIDER_TYPES = ["llm", "search", "embedding", "rerank", "image"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** LLM wire protocols. Every LLM vendor maps onto one of these. */
export const LLM_PROTOCOLS = ["openai", "anthropic", "gemini"] as const;
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];

export interface ConfigField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
}

export interface ProviderKindSpec {
  type: ProviderType;
  kind: string;
  label: string;
  defaultBaseUrl: string;
  /** Whether an API key is required (SearXNG / Ollama may run without). */
  keyRequired: boolean;
  /** Extra non-secret config fields shown in the form. */
  configFields?: ConfigField[];
  /** Whether listing models via API is supported. */
  canListModels: boolean;
  /** Static fallback model suggestions. */
  suggestedModels?: string[];
}

/**
 * LLM presets: `kind` is the protocol; presets just pre-fill name + base URL.
 */
export const LLM_PRESETS: { label: string; protocol: LlmProtocol; baseUrl: string; keyRequired: boolean }[] = [
  { label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", keyRequired: true },
  { label: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com", keyRequired: true },
  { label: "Google Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com", keyRequired: true },
  { label: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", keyRequired: true },
  { label: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", keyRequired: true },
  { label: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", keyRequired: true },
  { label: "Mistral", protocol: "openai", baseUrl: "https://api.mistral.ai/v1", keyRequired: true },
  { label: "xAI", protocol: "openai", baseUrl: "https://api.x.ai/v1", keyRequired: true },
  { label: "Ollama（公開端點）", protocol: "openai", baseUrl: "https://your-ollama.example.com/v1", keyRequired: false },
  { label: "OpenAI 相容（自訂）", protocol: "openai", baseUrl: "", keyRequired: false },
];

const extraHeaders: ConfigField = { key: "extraHeaders", label: "額外 HTTP 標頭（每行一個 Name: value，或 JSON 物件）", placeholder: "HTTP-Referer: https://example.com" };
const openaiFields: ConfigField[] = [
  { key: "api", label: "API 類型（chat 或 responses，預設 chat）", placeholder: "chat" },
  extraHeaders,
  { key: "streamUsage", label: "串流回報用量 stream_options（true/false，預設 true）", placeholder: "true" },
  { key: "replayReasoning", label: "回傳 reasoning_content（DeepSeek 思考＋工具；true/false）", placeholder: "false" },
];

const cfAccount: ConfigField = { key: "accountId", label: "Cloudflare Account ID", required: true };

export const PROVIDER_KINDS: ProviderKindSpec[] = [
  // LLM (kind = protocol)
  { type: "llm", kind: "openai", label: "OpenAI 相容", defaultBaseUrl: "https://api.openai.com/v1", keyRequired: false, canListModels: true, configFields: openaiFields },
  { type: "llm", kind: "anthropic", label: "Anthropic Messages", defaultBaseUrl: "https://api.anthropic.com", keyRequired: true, canListModels: true, configFields: [extraHeaders] },
  { type: "llm", kind: "gemini", label: "Gemini generateContent", defaultBaseUrl: "https://generativelanguage.googleapis.com", keyRequired: true, canListModels: true, configFields: [extraHeaders] },

  // Search (no Exa, no Brave — by decision)
  { type: "search", kind: "tavily", label: "Tavily", defaultBaseUrl: "https://api.tavily.com", keyRequired: true, canListModels: false },
  { type: "search", kind: "serper", label: "Serper", defaultBaseUrl: "https://google.serper.dev", keyRequired: true, canListModels: false },
  { type: "search", kind: "searxng", label: "SearXNG（自架）", defaultBaseUrl: "", keyRequired: false, canListModels: false },
  { type: "search", kind: "jina", label: "Jina Search", defaultBaseUrl: "https://s.jina.ai", keyRequired: true, canListModels: false },
  {
    type: "search", kind: "google_pse", label: "Google Programmable Search", defaultBaseUrl: "https://www.googleapis.com/customsearch/v1",
    keyRequired: true, canListModels: false, configFields: [{ key: "cx", label: "搜尋引擎 ID（cx）", required: true }],
  },

  // Embedding
  { type: "embedding", kind: "openai", label: "OpenAI", defaultBaseUrl: "https://api.openai.com/v1", keyRequired: true, canListModels: true, suggestedModels: ["text-embedding-3-small", "text-embedding-3-large"] },
  { type: "embedding", kind: "gemini", label: "Gemini", defaultBaseUrl: "https://generativelanguage.googleapis.com", keyRequired: true, canListModels: true, suggestedModels: ["gemini-embedding-001", "text-embedding-004"] },
  { type: "embedding", kind: "jina", label: "Jina", defaultBaseUrl: "https://api.jina.ai/v1", keyRequired: true, canListModels: false, suggestedModels: ["jina-embeddings-v3"] },
  { type: "embedding", kind: "voyage", label: "Voyage", defaultBaseUrl: "https://api.voyageai.com/v1", keyRequired: true, canListModels: false, suggestedModels: ["voyage-3.5", "voyage-3.5-lite", "voyage-code-3"] },
  { type: "embedding", kind: "cohere", label: "Cohere", defaultBaseUrl: "https://api.cohere.com", keyRequired: true, canListModels: false, suggestedModels: ["embed-v4.0", "embed-multilingual-v3.0"] },
  { type: "embedding", kind: "mistral", label: "Mistral", defaultBaseUrl: "https://api.mistral.ai/v1", keyRequired: true, canListModels: true, suggestedModels: ["mistral-embed"] },
  { type: "embedding", kind: "openai_compatible", label: "OpenAI 相容", defaultBaseUrl: "", keyRequired: false, canListModels: true },
  {
    type: "embedding", kind: "workers_ai", label: "Cloudflare Workers AI", defaultBaseUrl: "https://api.cloudflare.com/client/v4", keyRequired: false, canListModels: false,
    configFields: [
      { key: "accountId", label: "Cloudflare Account ID（走 REST API 時必填）" },
      { key: "useBinding", label: "部署在 Cloudflare 且有 AI 綁定時改用綁定（true/false；未填 Token 時自動使用）", placeholder: "false" },
    ],
    suggestedModels: ["@cf/baai/bge-m3", "@cf/baai/bge-base-en-v1.5"],
  },

  // Rerank
  { type: "rerank", kind: "jina", label: "Jina Reranker", defaultBaseUrl: "https://api.jina.ai/v1", keyRequired: true, canListModels: false, suggestedModels: ["jina-reranker-v2-base-multilingual"] },
  { type: "rerank", kind: "cohere", label: "Cohere Rerank", defaultBaseUrl: "https://api.cohere.com", keyRequired: true, canListModels: false, suggestedModels: ["rerank-v3.5"] },
  { type: "rerank", kind: "voyage", label: "Voyage Rerank", defaultBaseUrl: "https://api.voyageai.com/v1", keyRequired: true, canListModels: false, suggestedModels: ["rerank-2.5", "rerank-2.5-lite"] },

  // Image
  { type: "image", kind: "openai", label: "OpenAI 相容 Images", defaultBaseUrl: "https://api.openai.com/v1", keyRequired: false, canListModels: true, suggestedModels: ["gpt-image-1"] },
  { type: "image", kind: "gemini", label: "Gemini（圖片模型）", defaultBaseUrl: "https://generativelanguage.googleapis.com", keyRequired: true, canListModels: true },
  { type: "image", kind: "workers_ai", label: "Cloudflare Workers AI", defaultBaseUrl: "https://api.cloudflare.com/client/v4", keyRequired: true, canListModels: false, configFields: [cfAccount], suggestedModels: ["@cf/black-forest-labs/flux-1-schnell"] },
];

export function getKindSpec(type: string, kind: string): ProviderKindSpec | undefined {
  return PROVIDER_KINDS.find((k) => k.type === type && k.kind === kind);
}

export const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  llm: "語言模型",
  search: "網頁搜尋",
  embedding: "Embedding",
  rerank: "重排序",
  image: "圖片生成",
};

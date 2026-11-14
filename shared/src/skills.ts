/** Agent Skills (SKILL.md folders) — M8. */

export interface SkillFileDTO {
  path: string;
  size: number;
  mime: string;
}

export type SkillSource = "upload" | "editor" | "github" | "model" | "builtin";

export interface SkillDTO {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  sourceUrl: string | null;
  enabled: boolean;
  files: SkillFileDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillDetailDTO extends SkillDTO {
  /** Full SKILL.md text (front matter included). */
  skillMd: string;
  /** Parsed front matter (name, description, license, metadata …). */
  frontmatter: Record<string, unknown>;
}

export interface SkillImportResult {
  imported: SkillDTO[];
  skipped: { name: string; reason: string }[];
}

/** Agent Skills naming rule: lowercase letters, digits and single hyphens, 1–64 chars. */
export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;
export const SKILL_DESCRIPTION_MAX = 1024;

export const SKILL_TEMPLATE = `---
name: my-skill
description: 說明這個 Skill 做什麼、什麼時候該用它（模型依這段描述決定是否載入）。
---

# My Skill

## 何時使用
- …

## 步驟
1. …
`;

// ---------------- MCP (M9) ----------------

export type McpTransportKind = "streamable_http" | "sse";
export type McpAuthType = "none" | "bearer" | "headers" | "oauth";
export type McpAuthStatus = "none" | "configured" | "needs_auth" | "authorized";

export interface McpServerDTO {
  id: string;
  name: string;
  url: string;
  transport: McpTransportKind;
  authType: McpAuthType;
  authStatus: McpAuthStatus;
  /** Header names only (values are secret). */
  headerNames: string[];
  oauthClientId: string | null;
  oauthScope: string | null;
  enabled: boolean;
  toolPrefix: string;
  serverInfo: Record<string, unknown> | null;
  instructions: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
  toolCount: number;
  enabledToolCount: number;
  createdAt: string;
}

export interface McpToolDTO {
  id: string;
  serverId: string;
  name: string;
  /** Name the model sees: mcp__{prefix}__{tool}. */
  qualifiedName: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
  annotations: Record<string, unknown> | null;
  enabled: boolean;
  riskLevel: import("./agent").RiskLevel;
  riskCustomized: boolean;
}

export interface McpServerInput {
  name?: string;
  url?: string;
  transport?: McpTransportKind;
  authType?: McpAuthType;
  /** Bearer token (write-only; omit to keep). */
  bearer?: string;
  /** Custom headers (write-only; omit to keep). */
  headers?: Record<string, string>;
  oauthClientId?: string | null;
  /** Write-only; omit to keep. */
  oauthClientSecret?: string | null;
  oauthScope?: string | null;
  enabled?: boolean;
}

export interface McpSyncResponse {
  server: McpServerDTO;
  tools: McpToolDTO[];
  added?: number;
  removed?: number;
  /** Set when the server needs OAuth / credentials before tools can be listed. */
  needsAuth?: boolean;
  error?: string;
}

// ---------------- Memory & compaction (M10) ----------------

export type MemoryScope = "global" | "project" | "conversation";

export interface MemoryDTO {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  conversationId: string | null;
  content: string;
  source: "tool" | "auto" | "user";
  /** Embedding model used, null = keyword-only. */
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySettingsDTO {
  /** Inject the top-K relevant memories into every turn. */
  autoRecall: boolean;
  recallK: number;
  /** Minimum cosine similarity for auto recall (vector mode). */
  minScore: number;
  /** Extract durable facts from each finished exchange with an LLM. */
  autoExtract: boolean;
  /** Model for extraction and compaction summaries (null = the conversation's model). */
  helperModelId: string | null;
  /** Embedding model row id used for memories (null = first enabled embedding provider). */
  embeddingModelId: string | null;
  compaction: {
    enabled: boolean;
    /** Compact when the prompt exceeds this share of the model's context window. */
    threshold: number;
    /** Context window assumed when the model has none configured. */
    defaultContextTokens: number;
    /** Share of the window kept verbatim (most recent turns). */
    keepRecentRatio: number;
  };
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettingsDTO = {
  autoRecall: true,
  recallK: 5,
  minScore: 0.35,
  autoExtract: true,
  helperModelId: null,
  embeddingModelId: null,
  compaction: { enabled: true, threshold: 0.7, defaultContextTokens: 128_000, keepRecentRatio: 0.25 },
};

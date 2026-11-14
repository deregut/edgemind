// Conversations, projects, models picker, agent settings, files — DTOs shared by server routes and web.
import type { PermissionMode, RiskLevel } from "./agent";

export interface ConversationDTO {
  id: string;
  title: string | null;
  projectId: string | null;
  modelId: string | null;
  permissionMode: PermissionMode | null;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** Full-text search hit (only when listing with `q`). */
  snippet?: string;
}

export interface ConversationPatch {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  projectId?: string | null;
  modelId?: string | null;
  permissionMode?: PermissionMode | null;
}

export interface ProjectDTO {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  defaultModelId: string | null;
  permissionMode: PermissionMode | null;
  /** null = every tool enabled. */
  enabledTools: string[] | null;
  /** null = every enabled skill; else skill ids. */
  enabledSkills: string[] | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  conversationCount?: number;
}

export interface ProjectInput {
  name?: string;
  description?: string | null;
  instructions?: string | null;
  defaultModelId?: string | null;
  permissionMode?: PermissionMode | null;
  enabledTools?: string[] | null;
  enabledSkills?: string[] | null;
  archived?: boolean;
}

/** One selectable chat model (enabled LLM provider + enabled model row). */
export interface ModelOptionDTO {
  id: string;
  modelId: string;
  displayName: string | null;
  providerId: string;
  providerName: string;
  capabilities: Record<string, boolean>;
  contextLength: number | null;
}

export interface ToolInfoDTO {
  name: string;
  description: string;
  risk: RiskLevel;
  /** ask_user etc.: pauses the run for user input. */
  interactive?: boolean;
  /** Only offered inside a project (file_* tools). */
  projectOnly?: boolean;
}

/** Caps applied only while a run executes in 全部權限 (full) mode. 0 / null = no cap. */
export interface FullModeCaps {
  maxSteps: number | null;
  /** Input + output tokens of one run. */
  maxTokens: number | null;
  /** USD for one run, using per-model prices (settings `model_prices`, USD per 1M tokens). */
  maxCostUsd: number | null;
}

export interface AgentSettingsDTO {
  defaultModelId: string | null;
  maxSteps: number;
  fullModeCaps: FullModeCaps;
  /** modelRowId → { input, output } USD per 1M tokens. */
  modelPrices: Record<string, { input: number; output: number }>;
  /** Model used for automatic titles (null = the conversation's model). */
  titleModelId: string | null;
}

export interface FileDTO {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  scope: string;
  path: string;
  mime: string | null;
  size: number;
  version: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileVersionDTO {
  version: number;
  size: number;
  sha256: string | null;
  createdAt: string;
}

/** POST /api/uploads response. Single PUT for small files, multipart (browser → S3 parts) for big ones. */
export type UploadTicket =
  | { fileId: string; method: "put"; url: string; headers: Record<string, string> }
  | { fileId: string; method: "multipart"; partSize: number; parts: { partNumber: number; url: string }[] };

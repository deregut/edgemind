import type { ProviderType } from "./providers";

export interface EnvIssue {
  key: string;
  problem: "missing" | "invalid";
  hint: string;
}

export interface StatusResponse {
  env: { ok: boolean; issues: EnvIssue[] };
  db: { ok: boolean; error?: string; migrated?: boolean };
  setupRequired: boolean;
  authenticated: boolean;
  version: string;
}

export interface ProviderDTO {
  id: string;
  type: ProviderType;
  kind: string;
  name: string;
  baseUrl: string;
  /** Never the key itself: masked preview like "sk-…a1b2" or null. */
  apiKeyPreview: string | null;
  hasApiKey: boolean;
  enabled: boolean;
  priority: number;
  config: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderInput {
  type: ProviderType;
  kind: string;
  name: string;
  baseUrl?: string;
  /** undefined = keep existing; "" = clear; string = set. */
  apiKey?: string;
  enabled?: boolean;
  priority?: number;
  config?: Record<string, string>;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
}

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  detail?: Record<string, unknown>;
}

export const CSRF_HEADER = "x-csrf-token";
export const CSRF_COOKIE = "em_csrf";
export const SESSION_COOKIE = "em_session";

/** M11a: code_run (QuickJS server JS + Pyodide browser Python) and the secrets vault. */

export interface SecretDTO {
  id: string;
  name: string;
  /** Masked preview, never the value. */
  preview: string | null;
  allowedDomains: string[];
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** A project file mounted into a client-side (Pyodide) run; the browser fetches it via /api/files/:id/download. */
export interface ClientMount {
  path: string;
  fileId: string;
  size: number;
  mime: string | null;
}

/** Args stored on a pending `client` tool_approvals row (what the browser must execute). */
export interface ClientToolArgs {
  language: "python";
  code: string;
  files?: string[];
  timeoutSec?: number;
  projectId: string | null;
  conversationId: string;
  mounts: ClientMount[];
}

/** Result the browser POSTs to /api/runs/:id/client-results. */
export interface ClientToolResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  /** repr() of the last expression, if any. */
  result?: string | null;
  error?: string | null;
  durationMs?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  /** Full output saved as a project file when truncated. */
  fullOutput?: { path: string; fileId: string } | null;
  /** New / changed files uploaded to the project (figures included). */
  files?: { path: string; fileId: string; size: number; kind?: "file" | "figure" }[];
  /** Files produced but not saved (no project / too large). */
  notSaved?: { path: string; reason: string }[];
}

export const CODE_RUN_DEFAULT_TIMEOUT_SEC = 10;
export const CODE_RUN_MAX_TIMEOUT_SEC = 30;
export const PYODIDE_VERSION = "314.0.8";
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
/** Per-stream cap on stdout / stderr / return value sent back to the model. */
export const CODE_OUTPUT_CAP = 20_000;
/** Python runs in the browser (the run is paused meanwhile), so it may take longer; package loading is not counted. */
export const PYTHON_DEFAULT_TIMEOUT_SEC = 30;
export const PYTHON_MAX_TIMEOUT_SEC = 120;

/**
 * Permission gate (PLAN §6).
 *
 * Mode (inherited global → project → conversation; the lower level overrides):
 *   plan       read → allow; everything else → deny (also hidden from the model)
 *   normal     read → allow; write / dangerous / external → ask
 *   auto_edit  read + write → allow; dangerous / external → ask
 *   full       everything → allow
 *   custom     per-tool policies (allow / ask / deny + rules); tools without a policy fall back to `normal`
 *
 * Policies (tool_policies) are matched most-specific first: conversation > project > global scope, then exact
 * tool name > wildcard pattern > "*", then rule-bearing before rule-less. A policy with a rule only applies
 * when every target of the call matches (paths vs `pathGlob`, hosts vs `domains`).
 * Outside `custom` mode, policies can only tighten (a matching deny/ask beats the mode's allow).
 * "Allow for this conversation" grants turn an `ask` into `allow` but never override `deny`.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { PermissionMode, PolicyAction, PolicyRule, PolicyScope, RiskLevel } from "../../../shared/src/index";
import { PERMISSION_MODES } from "../../../shared/src/index";
import type { Database } from "../db/client";
import { conversations, projects, settings, toolApprovals, toolPolicies } from "../db/schema";
import { matchDomain, matchGlob, toolNameSpecificity } from "./glob";
import type { ToolTargets } from "./tools";

export interface Policy {
  id?: string;
  scope: PolicyScope;
  toolName: string;
  action: PolicyAction;
  rule?: PolicyRule | null;
}

export interface GateInput {
  mode: PermissionMode;
  toolName: string;
  risk: RiskLevel;
  targets: ToolTargets;
  policies: Policy[];
  /** Tool names granted "allow for this conversation". */
  grants: Set<string>;
}

export interface GateDecision {
  decision: PolicyAction;
  reason: string;
  source: "plan" | "mode" | "policy" | "grant";
  policyId?: string;
}

const MATRIX: Record<Exclude<PermissionMode, "custom">, Record<RiskLevel, PolicyAction>> = {
  plan: { read: "allow", write: "deny", dangerous: "deny", external: "deny" },
  normal: { read: "allow", write: "ask", dangerous: "ask", external: "ask" },
  auto_edit: { read: "allow", write: "allow", dangerous: "ask", external: "ask" },
  full: { read: "allow", write: "allow", dangerous: "allow", external: "allow" },
};

const STRICTNESS: Record<PolicyAction, number> = { allow: 0, ask: 1, deny: 2 };
const SCOPE_RANK: Record<PolicyScope, number> = { conversation: 3, project: 2, global: 1 };

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as readonly string[]).includes(v);
}

export function ruleMatches(rule: PolicyRule | null | undefined, targets: ToolTargets): boolean {
  if (!rule || (!rule.pathGlob && !rule.domains)) return true;
  if (rule.pathGlob) {
    if (!targets.paths?.length) return false;
    if (!targets.paths.every((p) => matchGlob(p, rule.pathGlob!))) return false;
  }
  if (rule.domains) {
    if (!targets.domains?.length) return false;
    if (!targets.domains.every((d) => matchDomain(d, rule.domains!))) return false;
  }
  return true;
}

const hasRule = (p: Policy) => !!(p.rule && (p.rule.pathGlob || p.rule.domains));

/** First applicable policy for a call, or undefined. */
export function matchPolicy(policies: Policy[], toolName: string, targets: ToolTargets): Policy | undefined {
  return policies
    .map((p) => ({ p, spec: toolNameSpecificity(p.toolName, toolName) }))
    .filter((x) => x.spec >= 0)
    .sort((a, b) => SCOPE_RANK[b.p.scope] - SCOPE_RANK[a.p.scope] || b.spec - a.spec || Number(hasRule(b.p)) - Number(hasRule(a.p)))
    .find((x) => ruleMatches(x.p.rule, targets))?.p;
}

export function evaluate(input: GateInput): GateDecision {
  const { mode, risk, toolName } = input;
  if (mode === "plan" && risk !== "read") return { decision: "deny", reason: "唯讀（Plan）模式只允許讀取類工具", source: "plan" };
  const policy = matchPolicy(input.policies, toolName, input.targets);
  let d: GateDecision;
  if (mode === "custom") {
    d = policy
      ? { decision: policy.action, reason: `自訂規則（${policy.scope}）：${policy.action}`, source: "policy", policyId: policy.id }
      : { decision: MATRIX.normal[risk], reason: "自訂模式未設定此工具，套用「一般」預設", source: "mode" };
  } else {
    d = { decision: MATRIX[mode][risk], reason: `權限模式「${mode}」對${risk}類工具的預設`, source: "mode" };
    if (policy && STRICTNESS[policy.action] > STRICTNESS[d.decision]) {
      d = { decision: policy.action, reason: `規則（${policy.scope}）：${policy.action}`, source: "policy", policyId: policy.id };
    }
  }
  if (d.decision === "ask" && input.grants.has(toolName)) return { decision: "allow", reason: "本對話已允許此工具", source: "grant" };
  return d;
}

// ---------------- DB-backed resolution ----------------

export async function globalMode(database: Database): Promise<PermissionMode> {
  const [row] = await database.db.select().from(settings).where(eq(settings.key, "permission_mode")).limit(1);
  return isPermissionMode(row?.value) ? row.value : "normal";
}

/** conversation → project → global → "normal". */
export async function resolveMode(database: Database, conversationId: string): Promise<{ mode: PermissionMode; projectId: string | null }> {
  const [conv] = await database.db
    .select({ cm: conversations.permissionMode, pm: projects.permissionMode, projectId: conversations.projectId })
    .from(conversations)
    .leftJoin(projects, eq(projects.id, conversations.projectId))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (isPermissionMode(conv?.cm)) return { mode: conv.cm, projectId: conv.projectId };
  if (isPermissionMode(conv?.pm)) return { mode: conv.pm, projectId: conv?.projectId ?? null };
  return { mode: await globalMode(database), projectId: conv?.projectId ?? null };
}

export async function loadPolicies(database: Database, conversationId: string, projectId: string | null): Promise<Policy[]> {
  const conds = [and(eq(toolPolicies.scope, "global"), isNull(toolPolicies.scopeId)), and(eq(toolPolicies.scope, "conversation"), eq(toolPolicies.scopeId, conversationId))];
  if (projectId) conds.push(and(eq(toolPolicies.scope, "project"), eq(toolPolicies.scopeId, projectId)));
  const rows = await database.db.select().from(toolPolicies).where(or(...conds));
  return rows.map((r) => ({ id: r.id, scope: r.scope as PolicyScope, toolName: r.toolName, action: r.action as PolicyAction, rule: (r.rule as PolicyRule) ?? null }));
}

export async function loadGrants(database: Database, conversationId: string): Promise<Set<string>> {
  const rows = await database.db
    .select({ toolName: toolApprovals.toolName })
    .from(toolApprovals)
    .where(and(eq(toolApprovals.conversationId, conversationId), eq(toolApprovals.status, "approved"), inArray(toolApprovals.scope, ["conversation"])));
  return new Set(rows.map((r) => r.toolName));
}

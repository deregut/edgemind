import type { StoredMessageDTO } from "@edgemind/shared";

export type Tree = Map<string, StoredMessageDTO>;

/** root → leaf along parent pointers. */
export function pathTo(tree: Tree, leafId: string | null): StoredMessageDTO[] {
  const out: StoredMessageDTO[] = [];
  const seen = new Set<string>();
  let cur = leafId ? tree.get(leafId) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.parentId ? tree.get(cur.parentId) : undefined;
  }
  return out.reverse();
}

export function childrenOf(tree: Tree, parentId: string | null): StoredMessageDTO[] {
  return [...tree.values()].filter((m) => m.parentId === parentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Siblings sharing parent and role (edit branches of a user message, regenerations of an answer). */
export function siblingsOf(tree: Tree, m: StoredMessageDTO): StoredMessageDTO[] {
  return childrenOf(tree, m.parentId).filter((x) => x.role === m.role);
}

/** Most recently created leaf inside the subtree of `id` (where a branch switch lands). */
export function latestLeaf(tree: Tree, id: string): string {
  const kids = new Map<string, StoredMessageDTO[]>();
  for (const m of tree.values()) if (m.parentId) (kids.get(m.parentId) ?? kids.set(m.parentId, []).get(m.parentId)!).push(m);
  let best: StoredMessageDTO | null = null;
  const stack = [tree.get(id)!];
  while (stack.length) {
    const m = stack.pop()!;
    const ks = kids.get(m.id);
    if (ks?.length) stack.push(...ks);
    else if (!best || m.createdAt > best.createdAt) best = m;
  }
  return best!.id;
}

export interface Turn {
  user: StoredMessageDTO | null;
  /** assistant + tool messages answering `user`. */
  replies: StoredMessageDTO[];
}

export function toTurns(path: StoredMessageDTO[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of path) {
    if (m.role === "user") turns.push({ user: m, replies: [] });
    else if (m.role === "assistant" || m.role === "tool") {
      if (!turns.length) turns.push({ user: null, replies: [] });
      turns[turns.length - 1].replies.push(m);
    }
  }
  return turns;
}

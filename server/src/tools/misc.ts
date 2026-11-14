/** todo (the model's own task list, stored on the conversation) and ask_user (pauses the run for an answer). */
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema";
import type { Tool } from "../agent/tools";

const STATUSES = ["pending", "in_progress", "done"] as const;

export const todoTool: Tool = {
  name: "todo",
  description: "管理你自己的任務清單（計畫）：傳入完整清單會整份取代；不傳 items 則讀取目前清單。多步驟任務開始前先列計畫，完成一項就更新狀態。",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: { content: { type: "string" }, status: { type: "string", enum: [...STATUSES] } },
          required: ["content", "status"],
        },
      },
    },
  },
  targets: () => ({}),
  async execute(args, ctx) {
    const db = ctx.database.db;
    if (!Array.isArray(args?.items)) {
      const [c] = await db.select({ t: conversations.todos }).from(conversations).where(eq(conversations.id, ctx.conversationId)).limit(1);
      return { items: c?.t ?? [] };
    }
    if (args.items.length > 100) throw new Error("清單最多 100 項");
    const items = args.items.map((i: any) => {
      const content = String(i?.content ?? "").trim().slice(0, 500);
      if (!content) throw new Error("每一項都需要 content");
      return { content, status: STATUSES.includes(i?.status) ? i.status : "pending" };
    });
    await db.update(conversations).set({ todos: items }).where(eq(conversations.id, ctx.conversationId));
    const done = items.filter((i: { status: string }) => i.status === "done").length;
    return { ok: true, items, progress: `${done}/${items.length}` };
  },
};

/** Executed by the agent loop itself: the run pauses (waiting_approval) until the user answers. */
export const askUserTool: Tool = {
  name: "ask_user",
  description: "需要使用者提供資訊或做決定才能繼續時，向使用者提問；執行會暫停直到使用者回答。可提供 choices 讓使用者快速選擇。",
  risk: "read",
  interactive: true,
  parameters: {
    type: "object",
    properties: {
      question: { type: "string" },
      choices: { type: "array", items: { type: "string" }, maxItems: 10 },
    },
    required: ["question"],
  },
  targets: () => ({}),
  async execute() {
    throw new Error("ask_user 由執行迴圈處理");
  },
};

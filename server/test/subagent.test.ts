import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Harness, callsReply, textReply } from "./harness";

const h = new Harness();
beforeAll(() => h.setup());
afterAll(() => h.teardown());
beforeEach(() => { h.script = []; h.llmBodies = []; });

describe("subagent", () => {
  it("runs an isolated read-only loop and returns only the final text", async () => {
    h.script = [
      callsReply([{ id: "s1", name: "subagent", args: { task: "查現在時間" } }]),
      callsReply([{ id: "u1", name: "get_time", args: { tz: "UTC" } }, { id: "u2", name: "ask_user", args: { question: "?" } }]),
      textReply("子代理結論：已查到"),
      textReply("主代理完成"),
    ];
    const r = await h.chat({ content: "派子代理" });
    expect(h.llmBodies).toHaveLength(4);
    const subTools = h.llmBodies[1].tools.map((t: any) => t.function.name);
    expect(subTools).toContain("get_time");
    expect(subTools).not.toContain("subagent");
    expect(subTools).not.toContain("ask_user");
    expect(h.llmBodies[1].messages).toHaveLength(2); // system + task only: isolated
    const toolMsgs = h.llmBodies[2].messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs[1].content).toContain("不可使用工具");
    expect(JSON.stringify(h.llmBodies[3].messages)).toContain("子代理結論");
    expect(r.events.some((e: any) => e.type === "done" && e.status === "completed")).toBe(true);
  });
});

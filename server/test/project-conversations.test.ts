/**
 * Regression for 「點擊專案，專案對話歷史爲空，舊對話不在專案中載入」: conversations started in a project are saved with its
 * projectId and every later turn stays in that same conversation; the list API filters by project and by "no project"
 * (what the sidebar 最近對話 shows); an existing conversation can be moved into and out of a project.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Harness, convOf, textReply } from "./harness";

const h = new Harness();
beforeAll(() => h.setup());
afterAll(() => h.teardown());
beforeEach(() => {
  h.script = [];
  h.llmBodies = [];
});

describe("project conversations", () => {
  it("are saved with projectId, continue in place, and are listed per project / outside projects", async () => {
    const c = h.client();
    const p = (await c.post("/projects", { name: "專案 A" })).body;
    const q = (await c.post("/projects", { name: "專案 B" })).body;
    h.script = [textReply("一"), textReply("二"), textReply("三"), textReply("四")];
    const loose = convOf((await h.chat({ content: "專案外的舊對話" })).events);
    const inP = convOf((await h.chat({ content: "專案內", projectId: p.id })).events);
    expect((await c.get(`/conversations/${inP}`)).body.projectId).toBe(p.id);

    // continuing the project conversation appends to it (never a new / other conversation)
    const cont = await h.chat({ content: "繼續", conversationId: inP });
    expect(convOf(cont.events)).toBe(inP);
    const msgs = (await c.get(`/conversations/${inP}/messages`)).body.messages;
    expect(msgs.filter((m: any) => m.role === "user").length).toBe(2);
    expect((await c.get(`/conversations/${loose}/messages`)).body.messages.filter((m: any) => m.role === "user").length).toBe(1);

    const ids = async (qs: string) => (await c.get(`/conversations${qs}`)).body.map((x: any) => x.id);
    expect(await ids(`?projectId=${p.id}`)).toEqual([inP]);
    expect(await ids(`?projectId=${q.id}`)).toEqual([]);
    expect(await ids("?projectId=none")).toEqual([loose]);
    expect((await ids("")).sort()).toEqual([loose, inP].sort());
    const bad = await c.get("/conversations?projectId=bogus");
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("none");

    // move the old conversation into the project, then out again
    expect((await c.req("PATCH", `/conversations/${loose}`, { projectId: p.id })).body.projectId).toBe(p.id);
    expect((await ids(`?projectId=${p.id}`)).sort()).toEqual([loose, inP].sort());
    expect(await ids("?projectId=none")).toEqual([]);
    expect((await c.get("/projects")).body.find((x: any) => x.id === p.id).conversationCount).toBe(2);
    // the moved conversation now runs with the project (a new turn keeps it there)
    expect(convOf((await h.chat({ content: "移入後", conversationId: loose })).events)).toBe(loose);
    expect((await c.get(`/conversations/${loose}`)).body.projectId).toBe(p.id);

    expect((await c.req("PATCH", `/conversations/${loose}`, { projectId: null })).body.projectId).toBeNull();
    expect(await ids("?projectId=none")).toEqual([loose]);
    expect(await ids(`?projectId=${p.id}`)).toEqual([inP]);
  });
});

import { describe, expect, it } from "vitest";
import { evaluate, matchPolicy, type Policy } from "../src/agent/permissions";
import { globToRegExp, matchDomain, matchGlob, toolNameSpecificity } from "../src/agent/glob";
import type { RiskLevel } from "../../shared/src/index";

const ev = (mode: any, risk: RiskLevel, policies: Policy[] = [], targets = {}, grants: string[] = [], toolName = "t") =>
  evaluate({ mode, toolName, risk, targets, policies, grants: new Set(grants) }).decision;

describe("mode matrix", () => {
  it.each([
    ["plan", ["allow", "deny", "deny", "deny"]],
    ["normal", ["allow", "ask", "ask", "ask"]],
    ["auto_edit", ["allow", "allow", "ask", "ask"]],
    ["full", ["allow", "allow", "allow", "allow"]],
    ["custom", ["allow", "ask", "ask", "ask"]],
  ])("%s", (mode, expected) => {
    expect((["read", "write", "dangerous", "external"] as RiskLevel[]).map((r) => ev(mode, r))).toEqual(expected);
  });
});

describe("policies", () => {
  it("custom: specific scope wins, exact name beats wildcard, rules gate applicability", () => {
    const policies: Policy[] = [
      { scope: "global", toolName: "*", action: "deny" },
      { scope: "global", toolName: "file_*", action: "ask" },
      { scope: "project", toolName: "file_write", action: "allow", rule: { pathGlob: "docs/**" } },
      { scope: "conversation", toolName: "file_write", action: "deny", rule: { pathGlob: "docs/private/**" } },
    ];
    expect(ev("custom", "write", policies, { paths: ["docs/a.md"] }, [], "file_write")).toBe("allow");
    expect(ev("custom", "write", policies, { paths: ["docs/private/k"] }, [], "file_write")).toBe("deny");
    expect(ev("custom", "write", policies, { paths: ["src/x.ts"] }, [], "file_write")).toBe("ask");
    expect(ev("custom", "write", policies, { paths: ["docs/a.md", "src/x"] }, [], "file_write")).toBe("ask");
    expect(ev("custom", "read", policies, {}, [], "web_search")).toBe("deny");
  });

  it("non-custom modes: policies only tighten", () => {
    const policies: Policy[] = [{ scope: "global", toolName: "file_delete", action: "ask" }, { scope: "global", toolName: "file_write", action: "allow" }];
    expect(ev("auto_edit", "write", policies, {}, [], "file_delete")).toBe("ask");
    expect(ev("normal", "write", policies, {}, [], "file_write")).toBe("ask");
    expect(ev("full", "dangerous", [{ scope: "global", toolName: "code_run", action: "deny" }], {}, [], "code_run")).toBe("deny");
    expect(ev("plan", "write", [{ scope: "global", toolName: "t", action: "allow" }])).toBe("deny");
  });

  it("conversation grants turn ask into allow but never override deny", () => {
    expect(ev("normal", "write", [], {}, ["t"])).toBe("allow");
    expect(ev("custom", "write", [{ scope: "global", toolName: "t", action: "deny" }], {}, ["t"])).toBe("deny");
  });

  it("domain rules", () => {
    const p: Policy[] = [{ scope: "global", toolName: "http_request", action: "allow", rule: { domains: ["api.example.com", "*.github.com"] } }];
    expect(matchPolicy(p, "http_request", { domains: ["api.example.com"] })).toBeDefined();
    expect(matchPolicy(p, "http_request", { domains: ["raw.github.com", "github.com"] })).toBeDefined();
    expect(matchPolicy(p, "http_request", { domains: ["example.com"] })).toBeUndefined();
    expect(matchPolicy(p, "http_request", {})).toBeUndefined();
  });
});

describe("glob helpers", () => {
  it("globs", () => {
    expect(matchGlob("docs/a/b.md", "docs/**")).toBe(true);
    expect(matchGlob("docs", "docs/**")).toBe(false);
    expect(matchGlob("a.md", "**/*.md")).toBe(true);
    expect(matchGlob("x/y/a.md", "**/*.md")).toBe(true);
    expect(matchGlob("docs/../etc/passwd", "docs/**")).toBe(false);
    expect(matchGlob("./docs/x", "docs/*")).toBe(true);
    expect(matchGlob("src/a.ts", "src/*.{ts,tsx}")).toBe(true);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
  });
  it("domains and tool-name patterns", () => {
    expect(matchDomain("API.Example.com.", ["api.example.com"])).toBe(true);
    expect(matchDomain("evil-example.com", ["*.example.com"])).toBe(false);
    expect(toolNameSpecificity("mcp:github/*", "mcp:github/create_issue")).toBe(1);
    expect(toolNameSpecificity("file_write", "file_write")).toBe(2);
    expect(toolNameSpecificity("*", "x")).toBe(0);
    expect(toolNameSpecificity("file_*", "web_fetch")).toBe(-1);
  });
});

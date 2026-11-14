import { describe, expect, it } from "vitest";
import { validateEnv, decodeKey32 } from "../src/env";
import { testEnv } from "./helpers";

describe("env validation", () => {
  it("reports every missing key with a hint", () => {
    const v = validateEnv({});
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.key)).toHaveLength(8);
    expect(v.issues.every((i) => i.problem === "missing" && i.hint.length > 0)).toBe(true);
  });
  it("flags invalid values", () => {
    const v = validateEnv({ ...testEnv("mysql://x"), ENCRYPTION_KEY: "short", JWT_SECRET: "abc" });
    expect(v.issues.map((i) => `${i.key}:${i.problem}`).sort()).toEqual([
      "DATABASE_URL:invalid", "ENCRYPTION_KEY:invalid", "JWT_SECRET:invalid",
    ]);
  });
  it("accepts a valid env, base64 or hex key", () => {
    expect(validateEnv(testEnv("postgres://u@h/db")).ok).toBe(true);
    expect(decodeKey32("ab".repeat(32))?.length).toBe(32);
    expect(decodeKey32(Buffer.alloc(16).toString("base64"))).toBeNull();
  });
});

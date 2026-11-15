import { describe, expect, it } from "vitest";
import { validateEnv, decodeKey32 } from "../src/env";
import { testEnv } from "./helpers";
import { S3 } from "../src/storage/s3";

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
  it("S3_FORCE_PATH_STYLE is optional and switches addressing", async () => {
    const base = testEnv("postgres://u@h/db");
    expect(validateEnv({ ...base, S3_FORCE_PATH_STYLE: "maybe" }).issues.map((i) => i.key)).toEqual(["S3_FORCE_PATH_STYLE"]);
    expect(validateEnv({ ...base, S3_FORCE_PATH_STYLE: "false" }).env?.S3_FORCE_PATH_STYLE).toBe("false");
    const s3env = { S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com/", S3_BUCKET: "my-b", S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: "AKIDEXAMPLE", S3_SECRET_ACCESS_KEY: "fake-secret" };
    expect(new S3(s3env).url("a b/c.txt")).toBe("https://s3.us-east-1.amazonaws.com/my-b/a%20b/c.txt");
    expect(new S3({ ...s3env, S3_FORCE_PATH_STYLE: "false" }).url("a b/c.txt")).toBe("https://my-b.s3.us-east-1.amazonaws.com/a%20b/c.txt");
    const seen: string[] = [];
    const vh = new S3({ ...s3env, S3_FORCE_PATH_STYLE: "false" }, async (req) => { const r = req as Request; seen.push(`${r.method} ${r.url} ${r.headers.get("x-amz-copy-source") ?? ""}`.trim()); return new Response("", { status: 200 }); });
    await vh.copy("x/1", "x/2");
    await vh.putBucketCors(["https://app.example"]);
    expect(seen).toEqual(["PUT https://my-b.s3.us-east-1.amazonaws.com/x/2 /my-b/x/1", "PUT https://my-b.s3.us-east-1.amazonaws.com/?cors="]);
  });
});

import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashPassword, maskSecret, verifyPassword, PBKDF2_ITERATIONS } from "../src/lib/crypto";

describe("crypto", () => {
  it("hashes and verifies passwords with PBKDF2 (CF-compatible iteration cap)", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith(`pbkdf2$sha256$${PBKDF2_ITERATIONS}$`)).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$sha256$999999999$AA==$AA==")).toBe(false);
  });
  it("AES-GCM round trip, random IV, AAD binding, tamper detection", async () => {
    const key = new Uint8Array(32).fill(3);
    const a = await encryptSecret("sk-secret", key, "provider:1");
    const b = await encryptSecret("sk-secret", key, "provider:1");
    expect(a).not.toEqual(b);
    expect(await decryptSecret(a, key, "provider:1")).toBe("sk-secret");
    await expect(decryptSecret(a, key, "provider:2")).rejects.toThrow();
    await expect(decryptSecret(a, new Uint8Array(32).fill(4), "provider:1")).rejects.toThrow();
    const parts = a.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -4)}AAA=`;
    await expect(decryptSecret(tampered, key, "provider:1")).rejects.toThrow();
  });
  it("masks secrets", () => {
    expect(maskSecret("sk-abcdefghijkl")).toBe("sk-a…ijkl");
    expect(maskSecret("short")).not.toContain("short");
  });
});

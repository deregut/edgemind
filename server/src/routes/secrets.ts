/**
 * Secrets vault API (M11a). Values are write-only: responses carry names, masked previews and allowed domains only.
 *   GET    /api/secrets
 *   POST   /api/secrets          { name, value, allowedDomains: string[], description? }
 *   PATCH  /api/secrets/:id      { name?, value? (empty = keep), allowedDomains?, description? }
 *   DELETE /api/secrets/:id
 */
import type { Hono } from "hono";
import type { HonoEnv } from "../context";
import { auditLogs } from "../db/schema";
import { createSecret, deleteSecret, listSecrets, toSecretDTO, updateSecret } from "../secrets";
import { BadInput } from "../lib/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function mountSecrets(app: Hono<HonoEnv>) {
  app.get("/secrets", async (c) => c.json({ secrets: (await listSecrets(c.get("database"))).map(toSecretDTO) }));

  app.post("/secrets", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const row = await createSecret(c.get("database"), c.get("encKey"), body);
    await c.get("database").db.insert(auditLogs).values({ action: "secret_create", detail: { name: row.name, allowedDomains: row.allowedDomains } });
    return c.json({ secret: toSecretDTO(row) }, 201);
  });

  app.patch("/secrets/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const row = await updateSecret(c.get("database"), c.get("encKey"), id, body);
    if (!row) return c.json({ error: "not_found", message: "找不到密鑰" }, 404);
    await c.get("database").db.insert(auditLogs).values({ action: "secret_update", detail: { name: row.name, valueChanged: !!body.value, allowedDomains: row.allowedDomains } });
    return c.json({ secret: toSecretDTO(row) });
  });

  app.delete("/secrets/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "not_found" }, 404);
    if (!(await deleteSecret(c.get("database"), id))) return c.json({ error: "not_found", message: "找不到密鑰" }, 404);
    await c.get("database").db.insert(auditLogs).values({ action: "secret_delete", detail: { id } });
    return c.json({ ok: true });
  });
}

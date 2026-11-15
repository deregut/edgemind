/**
 * 用量 (usage dashboard) + spend caps.
 *   GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Area/City   daily series + breakdown by model / kind / conversation / project
 *   GET /api/usage/status                                       today / this month vs caps (ok | warning | blocked)
 *   GET /api/settings/spend-caps,  PUT { dailyUsd, monthlyUsd, warnRatio, timezone }
 */
import type { Hono } from "hono";
import type { HonoEnv } from "../context";
import { BadInput } from "../lib/errors";
import { setSetting } from "../lib/settings";
import { isValidTimezone } from "../scheduler/cron";
import { getSpendCaps, normalizeSpendCaps, spendStatus, usageReport } from "../usage";

export function mountUsage(app: Hono<HonoEnv>) {
  app.get("/usage", async (c) => {
    try {
      return c.json(await usageReport(c.get("database"), { from: c.req.query("from"), to: c.req.query("to"), timezone: c.req.query("tz") }));
    } catch (e) {
      if (e instanceof RangeError) throw new BadInput(e.message);
      throw e;
    }
  });

  app.get("/usage/status", async (c) => c.json(await spendStatus(c.get("database"))));

  app.get("/settings/spend-caps", async (c) => c.json(await getSpendCaps(c.get("database"))));

  app.put("/settings/spend-caps", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    for (const k of ["dailyUsd", "monthlyUsd"] as const) {
      const v = body[k];
      if (v !== null && v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v >= 0)) throw new BadInput("上限必須是非負數字（留空代表不限）");
    }
    if (body.timezone !== undefined && !isValidTimezone(body.timezone)) throw new BadInput("時區無效（請用 IANA 名稱，例如 Asia/Taipei）");
    if (body.warnRatio !== undefined && !(typeof body.warnRatio === "number" && body.warnRatio > 0 && body.warnRatio < 1)) throw new BadInput("警告比例必須介於 0 與 1 之間");
    const caps = normalizeSpendCaps({ ...(await getSpendCaps(c.get("database"))), ...body });
    await setSetting(c.get("database"), "spend_caps", caps);
    return c.json(caps);
  });
}

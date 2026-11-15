// Netlify Scheduled Function: dispatches due 排程 tasks (POST /api/cron/tick in-process, HMAC-authenticated).
// Every 15 minutes by default. A shorter interval wakes the database more often (Neon free plan compute hours);
// change the expression below if you need finer granularity (e.g. "*/5 * * * *").
import { handleNetlifyCron } from "../../server/src/platform/netlify";

export default handleNetlifyCron;

export const config = { schedule: "*/15 * * * *" };

// Minimal local stand-in for Neon's HTTP SQL endpoint (what @neondatabase/serverless `neon()` POSTs to), backed by a
// local Postgres. Lets the API run with the SAME driver as Netlify / Cloudflare (neon-http) in dev and E2E:
//   NEON_PROXY_PORT=4444 PG_URL=postgres://postgres@127.0.0.1:54329/db node e2e/support/neon-http-proxy.mjs
// and start the API with DEV_DB_DRIVER=neon NEON_FETCH_ENDPOINT=http://127.0.0.1:4444/sql.
// Protocol: body { query, params } or { queries: [{ query, params }...] } (one transaction); rows are returned as
// arrays of raw text values with the column type OIDs, exactly like Neon (Neon-Raw-Text-Output / Neon-Array-Mode).
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const pg = require("pg");
const port = Number(process.env.NEON_PROXY_PORT ?? 4444);
const pools = new Map();
const raw = { getTypeParser: () => (v) => v };

function poolFor(cs) {
  const url = process.env.PG_URL || cs;
  let p = pools.get(url);
  if (!p) pools.set(url, (p = new pg.Pool({ connectionString: url, max: 5 })));
  return p;
}

const run = async (client, q) => {
  const r = await client.query({ text: q.query, values: q.params ?? [], rowMode: "array", types: raw });
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows, command: r.command, rowCount: r.rowCount };
};

http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const reply = (status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  let client;
  try {
    const data = JSON.parse(body || "{}");
    client = await poolFor(req.headers["neon-connection-string"]).connect();
    if (Array.isArray(data.queries)) {
      await client.query("BEGIN");
      try {
        const results = [];
        for (const q of data.queries) results.push(await run(client, q));
        await client.query("COMMIT");
        return reply(200, { results });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      }
    }
    return reply(200, await run(client, data));
  } catch (e) {
    return reply(400, { message: e.message, code: e.code, detail: e.detail, constraint: e.constraint });
  } finally {
    client?.release();
  }
}).listen(port, "127.0.0.1", () => console.log(`neon http proxy on http://127.0.0.1:${port}/sql`));

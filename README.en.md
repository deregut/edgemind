# EdgeMind

English ｜ [正體中文](README.md)

A single-user, self-hosted, serverless AI agent workspace: chat, projects, files, knowledge base, memory, Skills, MCP, web search and built-in tools, with every model and search provider configurable.

> 🚧 Work in progress. Done so far: M1 scaffold, M2 single-user auth + provider settings (LLM / search / embedding / rerank / image, model listing, connection tests).

## Highlights

- **Primary target: Netlify** (Functions); the same code also deploys to **Cloudflare Pages**
- **Neon Postgres + pgvector**; object storage via Neon Object Storage or any S3-compatible service
- Self-written LLM adapters (plain fetch): OpenAI-compatible, Anthropic Messages, Gemini generateContent
- All API keys encrypted with AES-GCM in the database
- UI in Traditional Chinese (正體中文), light / dark / system theme

## Layout

```
web/        SPA frontend (React + Vite + Tailwind + shadcn/ui)
server/     Hono API, Drizzle schema, migrations, platform adapters
shared/     Types and provider catalog shared by both sides
netlify/functions/api.ts   Netlify entry
functions/[[path]].ts      Cloudflare Pages entry
```

## Environment variables

Only these 8 values come from the environment; everything else is configured in the web UI:
`DATABASE_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`ENCRYPTION_KEY` (`openssl rand -base64 32`), `JWT_SECRET` (`openssl rand -base64 48`).

Missing or malformed values produce a clear error page listing what to fix.

## Deploy

- **Netlify**: import the repo (`netlify.toml` included), set the 8 variables, deploy, then open the site immediately to set the owner password (migrations run automatically).
- **Cloudflare Pages**: `npm ci && npm run build && npx wrangler pages deploy`, with the same variables set in the Pages project.

Full deployment guides will land in M12.

## Development

```bash
npm install
./scripts/test-db.sh   # local Postgres 17 + pgvector for tests
npm test
npm run build          # web + both function bundles
```

## License

TBD.

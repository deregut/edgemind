import { handlePages } from "../server/src/platform/cloudflare";

// Cloudflare Pages Functions: one catch-all mounting the same Hono app as Netlify.
export const onRequest = (context: Parameters<typeof handlePages>[0]) => handlePages(context);

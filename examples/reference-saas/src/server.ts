/**
 * エントリポイント。`bun run src/server.ts` で起動。
 * 本番の secret は環境変数から（env-config 等で検証して）注入すること。
 */
import { createApp } from "./app";

declare const Bun: { serve: (opts: { port: number; fetch: (req: Request) => Promise<Response> }) => unknown };

const app = createApp({ secret: process.env.SESSION_SECRET });
const port = Number(process.env.PORT ?? 3000);

Bun.serve({ port, fetch: (req) => app.handle(req) });
// eslint-disable-next-line no-console
console.log(`reference-saas listening on http://localhost:${port}`);

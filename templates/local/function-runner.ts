// Runs one Edge Function for local development (stitchdb start). The function's own Deno.serve() listens on the
// port the CLI chose; requests arrive as on StitchDB (path /<function>/...). Part of the stitchdb CLI, do not edit.
const port = Number(Deno.env.get('STITCHDB_FUNCTION_PORT'));
const slug = Deno.env.get('STITCHDB_FUNCTION_SLUG') ?? '';
const entry = Deno.env.get('STITCHDB_FUNCTION_ENTRY') ?? '';
type Handler = (req: Request, info: Deno.ServeHandlerInfo) => Response | Promise<Response>;
const serve = Deno.serve.bind(Deno) as (o: Deno.ServeTcpOptions, h: Handler) => Deno.HttpServer;
let started = false;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (a: any, b?: any) => {
  const handler: Handler = typeof a === 'function' ? a : (b ?? a?.handler);
  const opts = a && typeof a === 'object' ? a : {};
  if (started) throw new Error('Deno.serve() was called twice: a function serves one handler');
  started = true;
  return serve({ ...opts, port, hostname: '127.0.0.1', onListen() {} }, (req, info) =>
    new URL(req.url).pathname === `/${slug}/__stitchdb_ready` ? new Response('ok') : handler(req, info));
};
// deno-lint-ignore no-explicit-any
(globalThis as any).EdgeRuntime ??= { waitUntil(p: Promise<unknown>) { Promise.resolve(p).catch((e) => console.error(e)); } };
try {
  await import(entry);
} catch (e) {
  console.error(`${slug}: the function failed to start:`, e);
  Deno.exit(1);
}
if (!started) console.error(`${slug}: index.ts did not call Deno.serve(), so it cannot answer requests`);

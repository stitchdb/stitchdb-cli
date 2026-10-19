// StitchDB Edge Function. Docs: https://stitchdb.com/docs/cli/functions
// Locally: stitchdb functions serve, then
//   curl -i http://127.0.0.1:54321/functions/v1/__NAME__ -H "Authorization: Bearer <anon key>" -d '{"name":"World"}'

Deno.serve(async (req) => {
  const { name = 'World' } = await req.json().catch(() => ({}))
  return Response.json({ message: `Hello ${name}!` })
})

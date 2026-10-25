// StitchDB Edge Function with middleware. Docs: https://stitchdb.com/docs/functions/middleware
// Locally: stitchdb functions serve, then
//   curl -i http://127.0.0.1:54321/functions/v1/__NAME__ -H "Authorization: Bearer <user access token>"
import { pipeline, withClaims, withRequiredClaims, withStitchClient, HttpError } from 'https://stitchdb.com/sdk/stitchdb-middleware-2.1.0.mjs'

Deno.serve(pipeline([withClaims(), withRequiredClaims(), withStitchClient()], async (req, ctx) => {
  // ctx.claims: the signed-in user. ctx.stitch: a client acting as that user, so Row Level Security applies.
  const { data, error } = await ctx.stitch.auth.getUser()
  if (error) throw new HttpError(401, error.message)
  return Response.json({ id: ctx.claims.sub, email: data.user.email })
}))

# StitchDB CLI

Local development, migrations, TypeScript types, Edge Functions, secrets and preview branches for [StitchDB](https://stitchdb.com).

```sh
npm install -g stitchdb-cli
stitchdb login
stitchdb init
stitchdb link --project-ref <ref>
stitchdb start            # local stack (needs Docker)
stitchdb migration new create_todos
stitchdb db push
stitchdb gen types typescript --linked > src/database.types.ts
stitchdb functions deploy
```

Requires Node.js 18+. Local development requires Docker with the Compose plugin.
Full documentation: https://stitchdb.com/docs/cli

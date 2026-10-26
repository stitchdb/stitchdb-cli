# StitchDB CLI

Local development, migrations, typed clients (TypeScript, Dart, Swift, Kotlin), Edge Functions, secrets and preview branches for [StitchDB](https://stitchdb.com).

```sh
npm install -g stitchdb-cli
stitchdb login
stitchdb init
stitchdb link --project-ref <ref>
stitchdb start            # local Postgres, Auth, REST, Realtime, Storage, Functions (no Docker)
stitchdb migration new create_todos
stitchdb db push
stitchdb gen types typescript --linked -o src/database.types.ts
stitchdb types --watch -o src/database.types.ts   # rewrite on every schema change
stitchdb gen types swift --linked -o Sources/App/DatabaseTypes.swift
stitchdb functions deploy
```

Requires Node.js 18+ on macOS or Linux (Windows: use WSL). Local development needs no Docker: the first `stitchdb start`
downloads a small native runtime (about 40 MB) once into `~/.stitchdb/runtime`. Each project folder or git worktree gets its own
database and ports, and idle services stop after 10 minutes.
Full documentation: https://stitchdb.com/docs/cli

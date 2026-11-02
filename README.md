# StitchDB CLI

Local development, migrations, typed clients (TypeScript, Dart, Swift, Kotlin), Edge Functions, secrets, preview branches, project and organization management, logs, webhooks, AI agent keys and app features for [StitchDB](https://stitchdb.com).

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
stitchdb import "postgresql://…"   # copy another Postgres database in (live copy, then switch-over)
stitchdb sourcemaps upload dist --release 1.4.0   # readable crash stacks for that release
```

Requires Node.js 18+ on macOS or Linux (Windows: use WSL). Local development needs no Docker: the first `stitchdb start`
downloads a small native runtime (about 40 MB) once into `~/.stitchdb/runtime`. Each project folder or git worktree gets its own
database and ports, and idle services stop after 10 minutes.
Full documentation: https://stitchdb.com/docs/cli

## Projects, organizations and settings

Every command works on the linked project, `--project-ref <ref>`, or a ref given as the first argument. Organization
commands take `--org <id|name>` (default: your only organization, or `STITCHDB_ORG_ID`). Every command takes `--json`;
destructive ones ask first (`--yes` skips).

```sh
stitchdb projects create "Acme staging" --label env=staging --ttl 7d --wait
stitchdb projects get | update | pause | restore | delete <ref>
stitchdb projects api-keys rotate --grace 24h      # old keys keep working for the grace period
stitchdb projects limits set api_rps=20            # per-project caps; also: projects limits | usage | metrics
stitchdb projects tokens create --name ci --scopes database:read --expires-in 30m
stitchdb projects claim-links create --expires-in-days 7   # hand a project to another account
stitchdb region-move start eu-central --when quiet
stitchdb billing estimate --type project
stitchdb auth config update --site-url https://app.example.com --no-signup
stitchdb graphql enable
stitchdb network-restrictions set 203.0.113.7 198.51.100.0/24
stitchdb branches masking set public.customers.email=email
stitchdb domains add api.example.com && stitchdb domains check api.example.com
stitchdb vercel link my-next-app --prefix NEXT_PUBLIC_
stitchdb github link acme/app --production-branch main
stitchdb orgs members list | orgs invitations create bob@example.com --role developer
stitchdb orgs tokens create --name provisioning --scopes projects:read,projects:write
stitchdb orgs webhooks create https://example.com/hooks --events project.ready
stitchdb orgs audit-log --since 2026-10-01         # also: orgs list | billing | usage | apps
```

## Operations and monitoring

```sh
stitchdb logs --level error --since 1h --follow    # API, Auth, REST, Postgres or Edge Function logs
stitchdb logs query "select status, count(*) from api where status >= 500 group by status"
stitchdb log-drains create --name dd --kind datadog --api-key "$DD_API_KEY"
stitchdb webhooks create --name orders --url https://api.example.com/hooks --events db.insert --tables orders
stitchdb webhooks deliveries <id> && stitchdb webhooks replay <id>
stitchdb advisors security --fail-on error         # CI gate; also performance, health
stitchdb security exposure --fail-on critical      # what anonymous visitors can read or change
stitchdb db check -f stitchdb/migrations/<file>.sql   # locks and a safer version, before it runs
stitchdb inspect queries                           # slowest queries (inspect queries reset)
stitchdb functions logs hello --follow             # also: functions versions | stats | usage | rollback | update
stitchdb agents keys create --name cursor --preset app-dev --deny public.payments
stitchdb agents approvals approve <id>             # also: agents logins | audit | sessions revert
```

## App features (with the project's service key)

```sh
stitchdb crashes issues && stitchdb crashes resolve 42      # also: crashes issue | ignore | reopen | releases
stitchdb analytics funnel signup onboarding_done purchase   # also: analytics overview | trend | retention | user
stitchdb jobs start send-digest --payload '{"day":"2026-11-01"}'   # also: jobs list | get | logs | cancel | retry
stitchdb monitors ping hb_<token> --exit-code $?            # also: monitors list | get
stitchdb metering export --from 2026-10-01 --to 2026-11-01 -o october.csv   # also: usage | customers | alerts
stitchdb push send --topic news --title "Dark mode is here" # also: push status <id>
stitchdb search products "red running shoes"
stitchdb flags evaluate --user-id <uuid> --attributes '{"country":"DE"}'
```

A feature that is turned off answers with a hint to turn it on in Studio.

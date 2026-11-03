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
stitchdb cloudflare link my-worker --service-key     # Workers / Pages variables; CLOUDFLARE_API_TOKEN
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

A feature that is turned off answers with a hint to turn it on in Studio (or with the commands below).

## Dashboard features (access tokens)

Everything the dashboard sets up, through the Management API with your access token and its scopes:

```sh
stitchdb backups list | create | pitr | jobs          # also: backups restore <id> | download <id> [--files] | export
stitchdb backups restore-time 2026-11-01T14:30:00Z --branch before-incident
stitchdb backups restore-table public.orders --time 2026-11-01T09:00:00Z --mode merge --where "id = 4"
stitchdb compute sizes && stitchdb compute set <size key>   # billed from the prepaid balance; also compute get | estimate
stitchdb projects restart
stitchdb replicas list | add | remove <node>          # replicas auto get | auto set enabled=true max_replicas=2
stitchdb budget get | set --file budget.json | delete | test
stitchdb export start | list | import | restore <id> | delete <id>
stitchdb cron create cleanup --schedule '0 3 * * *' --command 'select purge_old()'   # cron list | runs | update | delete
stitchdb queues create jobs && stitchdb queues send jobs '{"id":1}'   # queues list | messages | read | archive | delete-message
stitchdb flags create new-checkout && stitchdb flags update new-checkout --enabled   # flags status | on | off | stats | history | restore | test | segments …
stitchdb rate-limits set --file rules.json            # rate-limits get | sql install | sql remove
stitchdb inbound endpoints create --provider stripe --secret "$STRIPE_WEBHOOK_SECRET"   # inbound status | on | off | events list | redeliver …
stitchdb status-page incidents create --title "Slow API" --impact minor --message "Looking into it"   # status-page get | on | set | subscribers …
stitchdb push configure --ios-p8 AuthKey.p8 --key-id ABC123DEFG --team-id XYZ987TEAM --bundle-id com.example.app   # push settings | test | disable
stitchdb purchases configure --file iap.json          # purchases settings | webhook-test | retry | disable
stitchdb links create --path /invite/42               # links status | on | off | settings set | list | get | update | delete
stitchdb metering stripe customers set acme=cus_123   # metering status | on | off | settings set | stripe set | stripe retry
stitchdb monitors create nightly --schedule '0 3 * * *' --grace 30m   # monitors setup | on | off | alerts set | update | rotate | test-alert
stitchdb crashes alerts set new_issue=true            # crashes settings | on | off | test-alert
stitchdb auth sso add --metadata-url https://idp.example.com/metadata --domain example.com   # auth sso list | update | remove
stitchdb recycle-bin enable orders && stitchdb recycle-bin restore 11 12   # recycle-bin list | disable | purge
stitchdb history enable orders && stitchdb history revert 4   # history list | disable
stitchdb shared-views create --name "Open orders" --table orders --columns id,total   # shared-views list | members add …
```

## Auth, e-mail and sign-in

Secrets (SMTP password, provider secrets, API keys) are read hidden, or from `--secret-stdin` / `--secret-file`, so they
never land in shell history. The API stores them encrypted and never returns them.

```sh
stitchdb auth smtp set --host smtp.example.com --port 587 --user apikey --from no-reply@example.com --sender-name "Example"
stitchdb auth smtp get | remove
stitchdb auth templates set recovery --html recovery.html --subject "Reset your password"   # templates test <kind>
stitchdb auth email-domain add domain=mail.example.com && stitchdb auth email-domain verify   # e-mails from your own domain
stitchdb auth providers enable github --client-id Iv1.abc123       # the client secret is asked for; providers list | disable
stitchdb auth sms set twilio account_sid=AC123 message_service_sid=MG456 && stitchdb auth phone on
stitchdb auth email on | off       # also: auth signup on|off, auth autoconfirm on|off, auth anonymous on|off
stitchdb auth users list | get | create | update | delete | sign-out | recovery-link | send-recovery | send-magic-link
stitchdb auth invite email=new@example.com
stitchdb auth orgs status | on | off | settings | list | get
stitchdb auth signup-protection set block_disposable=true       # hosted-login status | on | off | set
```

## Database, storage and the rest of the dashboard

```sh
stitchdb db tables | columns public.todos | views | functions | triggers | indexes | policies | extensions | connections
stitchdb db rows public.todos limit=20 && stitchdb db rows insert public.todos title="Buy milk"   # rows update | delete --pk '{"id":1}' | export
stitchdb db tables create --file table.json          # tables update | drop, columns add | update | drop, indexes create | drop …
stitchdb db extensions install pg_trgm               # policies create | update | drop, triggers enable | disable | drop
stitchdb db roles create name=reporter preset=read   # roles update | delete; db rls users | rows | explain
stitchdb vault create name=stripe_key --secret-stdin < key.txt   # vault list | update | delete (values stay in the dashboard)
stitchdb sql snippets | sql history                  # sql-http status | on | off | keys create | keys revoke; test-data …
stitchdb storage buckets create name=avatars public=true && stitchdb storage ls avatars   # storage mv | rm | sign | mkdir | s3 …
stitchdb stripe connect tables='["customers"]' --secret-stdin   # stripe status | backfill | disconnect
stitchdb realtime history on days=7 | search status | jobs on | analytics on | sync tables add public.notes | collab on
stitchdb reports create --file report.json           # reports list | preview | run | runs …; health-alerts status | set | test
stitchdb typegen set languages='["typescript","swift"]' && stitchdb typegen regenerate
```

## Account

```sh
stitchdb billing | billing invoices | billing cap set cap_cents=5000 | billing spend-cap enabled=true
stitchdb support open subject="Slow queries" body="Since 10:00 UTC" project_ref=<ref>   # support list | get | reply | close
stitchdb servers add name=box1 host=203.0.113.7 region=eu --secret-stdin   # servers list | get | log | move | remove …
stitchdb compute catalog && stitchdb compute servers resize 12 size_key=ccx33
stitchdb ai ask "Why is my orders query slow?"       # ai status | ai chat
stitchdb orgs rename "Acme Inc" && stitchdb orgs invitations resend <id>
```

Anything else in the Management API (https://stitchdb.com/docs/api):

```sh
stitchdb api GET /projects/<ref>/database/tables --query schema=public
stitchdb api PATCH /projects/<ref>/config/auth site_url=https://app.example.com
```

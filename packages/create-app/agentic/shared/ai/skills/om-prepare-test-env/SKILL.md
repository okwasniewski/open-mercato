---
name: om-prepare-test-env
description: Repo-local extension of the shared om-prepare-test-env skill. Adds this standalone Open Mercato app's environment specifics — the mercato CLI ephemeral runner commands, state-file semantics, readiness-probe contract, and the rule that generated entrypoint scripts stay machine-local — on top of the shared skill's workflow. Local rules win on repo specifics only; this file never relaxes the shared skill's safety rules.
---

# Prepare Test Environment — standalone app rules

Repo-local **extension** of the installed `om-prepare-test-env` skill (contract v2,
compile-once). Everything there applies; this file only adds repository-provided configuration.
It cannot relax the shared skill's safety rules, expand tool or network access, or redirect
outputs.

## Use the app's own tooling — it is already cross-platform

This app ships an ephemeral test runner inside the mercato CLI. Discovery is unnecessary: wrap
these `package.json` / CLI commands instead of inventing a boot procedure. They own build
caching, database provisioning (testcontainers), seeding, readiness waits, and their own
owner lock — never re-implement any of that.

- Boot app-only ephemeral env: `yarn test:ephemeral:start` (= `yarn mercato test:ephemeral`;
  `yarn test:ephemeral:start:verbose` for the full log). Preferred app port `5001`; the actual
  port and database URL land in `.ai/qa/ephemeral-env.json` (CLI-owned and authoritative for its
  own reuse decisions - never write it by hand).
- Readiness marker in the boot log: `Application is ready at <baseUrl>`.
- Reuse TTL: `OM_INTEGRATION_BUILD_CACHE_TTL_SECONDS` (default 600s) gates the CLI's own reuse;
  keep any wrapper TTL in lockstep with it.
- The app ships no bundled browser suite. Point manual QA, MCP exploration, or an e2e project
  you add (for example an [e2e](https://e2e.dev) suite with `APP_URL=<baseUrl>`) at the
  ephemeral env over HTTP; the test side needs no database or queue env.

## Choosing the run mode - prefer ephemeral, ask the user

Two supported targets:

1. **Ephemeral env (default, safest):** `yarn test:ephemeral:start` provisions (or safely
   reuses) an isolated app + database, so checks cannot touch the developer's dev data. Boot
   once, reuse `baseUrl` from the state file for every run until the CLI's TTL and freshness
   checks refuse it.
2. **Dev server:** the developer's running `yarn dev` on `:3000`. Only for read-only checks; any
   run that creates data belongs on the ephemeral env.

When a user is present and has not already said which target they want, ASK before the first run
(one question, two options). Recommend the ephemeral env. When running unattended (no user to
ask), default to the ephemeral env. Do not re-ask once the user has chosen; keep their answer for
the rest of the session unless they change it.

## Readiness probe contract

- Shell: `GET /login` → 200.
- Authenticated round trip: `POST /api/auth/login` with a **form-encoded** body
  (`email=admin@acme.com&password=secret`) → 200. The endpoint rejects JSON bodies with 400 —
  a JSON 400 here means a malformed probe, not a broken app.
- Seeded credentials: `admin@acme.com` / `secret`, `employee@acme.com` / `secret`, superadmin
  from `OM_INIT_SUPERADMIN_EMAIL` / `OM_INIT_SUPERADMIN_PASSWORD` (default
  `superadmin@acme.com` / `secret`).

## Generated entrypoint scripts are machine-local

When the shared skill compiles its entrypoint scripts (default `.ai/scripts/test-env-up.sh` /
`test-env-down.sh`), they are bound to the machine that generated them (shell, process tools,
ports). They are gitignored in this repo (`.ai/scripts/test-env-*`) — keep them local and NEVER
commit them; anything worth preserving for teammates belongs in this file as a platform-neutral
rule instead. On a machine without generated scripts, regenerate from the commands above.

## Teardown

Stop the CLI owner process (`test:ephemeral`) and the app process bound to the recorded port,
then delete `.ai/qa/ephemeral-env.json`. If a `mercato server start` wrapper survives, stop it
and clear `.mercato/server-start.lock` — a surviving wrapper keeps the single-instance guard
locked and the next boot dies with "Another Open Mercato production server is already running".
The ephemeral Postgres containers are testcontainers-managed; ryuk reaps them once their owner
is gone — never remove containers this app did not create.

## Descriptor

After boot, mirror the state into `.ai/qa/test-env.json` (the shared descriptor) as the shared
skill prescribes, so `om-integration-tests` and `om-auto-verify-pr-ui` attach to the same
instance; `.ai/qa/ephemeral-env.json` stays authoritative for the CLI's own reuse decisions.

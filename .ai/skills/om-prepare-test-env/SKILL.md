---
name: om-prepare-test-env
description: Repo-local extension of the shared om-prepare-test-env skill (installed in .agents/skills/). Adds Open Mercato monorepo environment specifics — the generated entrypoint scripts, ephemeral runner commands, reuse TTL semantics, owner-lock teardown, and the env-block contract — on top of the shared skill's workflow. Local rules win on repo specifics only; this file never relaxes the shared skill's safety rules.
---

# Prepare Test Environment — Open Mercato repo rules

Repo-local **extension** of `.agents/skills/om-prepare-test-env/SKILL.md` (contract v2,
compile-once). Everything there applies; this file only adds repository-provided configuration
and lessons. It cannot relax the shared skill's safety rules, expand tool or network access, or
redirect outputs.

## Generated entrypoints are machine-local — the CLI commands are the repo interface

The `package.json` / mercato CLI commands below are the authoritative, cross-platform way to
boot and reuse the test environment — wrap THEM when compiling entrypoints; never invent a boot
procedure. Any entrypoint scripts this skill compiles (default `.ai/scripts/test-env-up.sh` /
`test-env-down.sh`) are bound to the machine that generated them (shell, ports, process tools)
and are gitignored (`.ai/scripts/test-env-*`): keep them local, NEVER commit them. Anything
worth preserving for teammates belongs in this file as a platform-neutral rule instead. On a
machine without generated entrypoints, regenerate from the commands and contracts in this file
(discovered mode: wrap `yarn test:ephemeral:start`, attach when the CLI state file's
env probes healthy, write `.ai/qa/test-env.json`; teardown stops only the CLI owner + app —
the ephemeral Postgres containers are testcontainers/ryuk-managed). The repo CLI owns build
cache, provisioning, seeding, and its own owner lock — an entrypoint never re-implements those
(state file `.ai/qa/ephemeral-env.json` stays authoritative).

## App env block

The ephemeral app is booted by the repo CLI with its own env block (`buildReusableEnvironment`
in `packages/cli/src/lib/testing/integration.ts`): an isolated `DATABASE_URL`, `QUEUE_BASE_DIR`,
`JWT_SECRET`, mock webhook secrets, `ENABLE_CRUD_API_CACHE`. A generated `test-env-up.sh` adds
`MOCK_INBOUND_WEBHOOK_SECRET`, `OM_WEBHOOKS_ALLOW_PRIVATE_URLS=1`, `OM_OPTIMISTIC_LOCK=all`,
`SELF_SERVICE_ONBOARDING_ENABLED=true`, `OM_INTEGRATION_APP_READY_TIMEOUT_SECONDS=180`; the
enterprise flags (`OM_ENABLE_ENTERPRISE_MODULES{,_SSO,_SECURITY}=true`) stay `false` locally and
change the app build fingerprint when exported (forces a rebuild).

## Environment commands (authoritative)

- Boot app-only ephemeral env: `yarn test:ephemeral:start` (= `yarn mercato test:ephemeral`;
  `yarn test:ephemeral:start:verbose` for the full log). Preferred app port `5001`; the actual
  port and DB URL land in `.ai/qa/ephemeral-env.json` (managed by the CLI, never write it by hand).
- Run the browser suite against it from `e2e/`: `cd e2e && APP_URL=<baseUrl> npm test`
  (`-- --tag <area>` or `-- <file>` to narrow). The suite reaches the app over HTTP only, so
  `APP_URL` is the whole contract: no database or queue env is needed on the test side. Setup
  once: `npm install && npx @e2e-dev/web install chromium`. Details in the `om-integration-tests`
  skill.

## Run mode

Boot once, iterate against the running env. The e2e suite never provisions an app itself, so the
descriptor's `baseUrl` is reused for every run until the TTL and freshness rules below refuse it.
The alternative is the developer's `yarn dev` server on `:3000` (the suite's default `APP_URL`);
prefer the ephemeral env whenever the run creates data, so the dev database stays untouched.

## Reuse TTL and the owner-lock deadlock

- Reuse eligibility is gated by `OM_INTEGRATION_BUILD_CACHE_TTL_SECONDS` (default 600s) AND
  source freshness. An env older than the TTL, or with source files modified after boot, is
  refused for reuse.
- When reuse is refused while the original `test:ephemeral` owner process is still alive, a fresh
  start is also refused ("Another ephemeral environment is already active started by
  \"ephemeral\" (pid N)") — a deadlock. Resolve it by tearing down the owner: kill the
  `packages/cli/dist/bin.js test:ephemeral` PID and the `next-server` PID bound to the app port,
  delete `.ai/qa/ephemeral-env.json`, then boot fresh. The ephemeral Postgres containers are
  testcontainers-managed (ryuk reaps them).
- For short diagnose/re-run loops against the SAME env that produced a failure, extend the TTL
  when re-booting: `OM_INTEGRATION_BUILD_CACHE_TTL_SECONDS=86400 yarn test:ephemeral:start` - but
  only when no source file changed since boot; otherwise rebuild (never test stale code).

## Stale-port zombie check

Before booting, probe the preferred port (`lsof -iTCP:5001 -sTCP:LISTEN`). A `next-server` that
listens but does not answer HTTP (curl exit 000) and has no `.ai/qa/ephemeral-env.json` is a
leftover from a dead run — kill it so the runner gets its stable preferred port.

## Readiness probe contract

- Shell: `GET /login` → 200.
- Authenticated round trip: `POST /api/auth/login` with **form-encoded** body
  (`email=admin@acme.com&password=secret`) → 200. The endpoint rejects JSON bodies with 400 —
  a JSON 400 here means a malformed probe, not a broken app.
- Seeded credentials: `admin@acme.com` / `secret`, `employee@acme.com` / `secret`,
  superadmin from `OM_INIT_SUPERADMIN_EMAIL`/`OM_INIT_SUPERADMIN_PASSWORD` (default
  `superadmin@acme.com` / `secret`).

## Descriptor

After boot, mirror the state into `.ai/qa/test-env.json` (shared descriptor) as the shared skill
prescribes; `.ai/qa/ephemeral-env.json` (CLI-owned) stays authoritative for the runner's own
reuse decisions.

## Switching commits on one worktree (before/after QA) — 2026-08-05

A before/after UI QA run repoints the **same** worktree at another commit and boots again. Two traps
make that silently serve the wrong build, and both produce evidence that looks real and is not:

- **`--force` is not enough.** It skips the entrypoint descriptor's own reuse check, but the repo
  CLI still decides independently whether to rebuild, and it can reuse the **previous** commit's
  `.next` artifacts. Symptom: the "before" and "after" screenshots are byte-identical and `startedAt`
  in the descriptor never moves. Use `--force-rebuild` — the entrypoint contract's flag for exactly
  this — which is what actually invalidates the CLI's build cache
  (`OM_INTEGRATION_BUILD_CACHE_TTL_SECONDS`, `integration.ts:159`). How the generated
  `.ai/scripts/test-env-up.sh` wires the flag through is its own business and is not committed
  (see below), so check the script rather than assuming a particular variable.
- **Killing the pids is not enough either.** The CLI's reuse decision is driven by its state file
  `.ai/qa/ephemeral-env.json` (`EPHEMERAL_ENV_FILE_PATH`,
  `packages/cli/src/lib/testing/integration.ts:269`), **not** by probing the app port — it logs
  `Reusing existing ephemeral environment at …` (`integration.ts:2062`) after reading that file. So
  deleting the file does not help while the previous launcher is alive, because that process keeps
  republishing it. Run `test-env-down.sh` and confirm the port is free before booting again; the
  teardown is the remedy, not the `rm`.

Know what the CLI's rebuild guards actually are, so a surprise is recognisable. There are two: the
age of the environment against `OM_INTEGRATION_BUILD_CACHE_TTL_SECONDS` (default
`DEFAULT_BUILD_CACHE_TTL_SECONDS = 600`, `integration.ts:157-159`), and an mtime check,
`hasBuildInputChangesSince(startedAtMs)` (`integration.ts:2047`), which logs `Source files changed
since the current ephemeral environment started. Rebuilding.` Reuse has been observed **despite**
that second guard, so do not treat "I changed files, therefore it rebuilt" as safe.

**That is why the rule is to verify the rebuild rather than to reason about the guards.** A fresh
ephemeral Postgres port in `services[0].url` plus a moved `startedAt` is the confirmation — and the
new port means any row you seeded is gone, so re-seed after every rebuild. Recording the built commit
in the descriptor and forcing a rebuild when it changes, or is unknown, turns this into a guard — but
note that this lives in the generated `.ai/scripts/test-env-up.sh`, which is gitignored
(`.gitignore:145`, `.ai/scripts/test-env-*`) and regenerated per checkout. A fresh clone does **not**
inherit it, and must verify manually or re-add it.

## Seeding rows the UI needs — 2026-08-05

`users.email` is encrypted at rest with a per-row IV — the `User` entity's own comment says so
(`packages/core/src/modules/auth/data/entities.ts:8`), and the field is declared encrypted in the
module's `defaultEncryptionMaps` (`packages/core/src/modules/auth/encryption.ts:7`,
`{ field: 'email', hashField: 'email_hash' }`). So `select … from users where email =
'admin@acme.com'` finds nothing and a seed script keyed on it fails. Two ways out:

- **Simplest when the script already has credentials:** resolve the identity through the app —
  `POST /api/auth/login` with a form-encoded body, then read `sub` / `tenantId` / `orgId` out of the
  returned JWT payload and insert the fixture rows with those ids.
- **When you must stay in SQL:** key on the indexed `email_hash` column (`entities.ts:27-29`, index
  `users_email_hash_idx`) rather than on the encrypted `email` — but compute the value with
  `computeEmailHash` (`packages/core/src/modules/auth/lib/emailHash.ts:3`), never a bare
  `sha256('admin@acme.com')`, and match **two** candidates rather than one. The column is not a plain
  digest: `hashForLookup` (`packages/shared/src/lib/encryption/aes.ts:141`) HMACs the lowercased,
  trimmed email (`normalizeLookupValue`, `aes.ts:87`) under a pepper resolved from
  `LOOKUP_HASH_PEPPER` / `TENANT_DATA_ENCRYPTION_FALLBACK_KEY` / `TENANT_DATA_ENCRYPTION_KEY`
  (`resolveLookupPepper`, `aes.ts:116-128`) and stores it as `v2:<digest>`. A pepper normally does
  resolve — `apps/mercato/.env.example:365` ships a non-empty
  `TENANT_DATA_ENCRYPTION_FALLBACK_KEY` — so a booted
  test env holds `v2:` values. Only when none resolves does it fall back to the legacy unkeyed
  `sha256(lower(trim(email)))` (`legacyHashForLookup`, `aes.ts:100-102`), and rows written before the
  keyed format still hold that legacy digest. That is why the application never keys on one value: it
  matches `$in [primary, legacy]` via `emailHashLookupValues` / `lookupHashCandidates`
  (`aes.ts:159-163`), as `services/authService.ts:19` and `commands/users.ts:218` do. Match both the
  same way (`where email_hash in (…)`), and run the script with the app's own env loaded so the
  pepper resolves exactly as it did on the write — otherwise you get zero rows against a perfectly
  good database, the same silent, error-free dead end as querying the encrypted `email`. Reference
  the pepper by **env var name** only; never copy the value into a script, a log, or this file.

## Driving the backoffice login — 2026-08-05

The login form is client-hydrated, so `goto('/login', { waitUntil: 'domcontentloaded' })` followed by
an immediate fill and submit fires before React attaches its handler: the page stays on `/login` and
logs a 400. Wait for `networkidle` plus a short settle, fill `#email` / `#password`, click
`button[type=submit]`, then poll `page.url()` — the post-login transition is client-side, so
`waitForURL` and `waitForFunction` both hang on it.

## Browser install offline - 2026-08-05

When the sandbox has no network, `npx @e2e-dev/web install chromium` (run inside `e2e/`) downloads
nothing, so it cannot repair a mismatch between the `playwright-core` pinned by `@e2e-dev/web` and
the builds already in `~/Library/Caches/ms-playwright`. Check what is actually cached before
blaming the app; neighbouring Chromium builds usually still launch.

## A fresh worktree needs the full prepare chain before the CLI — 2026-08-10

`yarn install` alone is not enough to boot the ephemeral env in a newly created worktree, and both
failures present as something other than their cause:

- **`packages/cli/dist/bin.js` is a build artifact.** Without it `yarn test:ephemeral:start`
  dies with a bare `MODULE_NOT_FOUND` Node stack that never names the CLI, so the boot log looks like
  a broken script rather than an unbuilt workspace.
- **One `build:packages` pass is not enough.** The root `build` script is
  `build:packages && generate && build:packages` in that order for a reason: the first pass produces
  the compilers, `generate` writes `packages/core/dist/generated/entities.ids.generated.js`, and the
  second pass links it. Stopping after one pass boots an app that gets all the way to init and then
  fails with `ERR_MODULE_NOT_FOUND` on that generated file — after several minutes of apparently
  healthy progress output.

So an entrypoint compiled on a fresh checkout must gate on **both** artifacts and run all three steps:

```sh
if [ ! -f packages/cli/dist/bin.js ] || [ ! -f packages/core/dist/generated/entities.ids.generated.js ]; then
  for step in build:packages generate build:packages; do yarn "$step" || exit 1; done
fi
```

An entrypoint generated in a worktree that had already run the full validation gate will not reveal
either problem — the tree was already prepared — which is why this is a checkout-shaped trap rather
than a machine-shaped one.

## Keep generated artifacts on the names .gitignore already covers — 2026-08-10

`.gitignore` covers `.ai/qa/ephemeral*`, `.ai/qa/test-env.json`, `.ai/qa/test-env.lock/` and
`.ai/qa/test-env-boot.log`, but not arbitrary neighbours. An entrypoint that invents
`test-env-up.log` or `.test-env-cli.pid` leaves untracked files a careless `git add -A` will commit.
Write the boot log to `test-env-boot.log` and keep pid files inside `test-env.lock/`.

Related trap in the lock itself: if the bootstrap lock **is** the `test-env.lock` directory, the
`trap 'rm -rf "$LOCK_DIR"' EXIT` that releases it also deletes the `cli.pid` teardown needs. Make the
lock a *file inside* the directory (`test-env.lock/bootstrap.pid`) and remove only that file on exit.

## Retry the fixed Testcontainers port-binding window — 2026-08-11

Testcontainers 11 polls Docker inspect for host port bindings for a fixed 10 seconds before its
normal startup wait strategy begins. Docker Desktop can exceed that window under load even though
the same image and daemon are healthy, causing `test:ephemeral` to exit before the app or database
readiness gates run. The generated entrypoint retries the complete repository CLI boot up to three
times only when the log contains the exact `waiting for container ports to be bound to the host`
failure. Other failures still stop immediately, and Testcontainers/Ryuk retains ownership of any
container created by the failed attempt.

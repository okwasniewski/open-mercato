---
name: om-integration-tests
description: Run and write the agentic e2e suite in e2e/tests (e2e runner, https://e2e.dev), including running the whole suite or one area/file, porting markdown scenarios, and adding tests from specs or feature descriptions. Defers environment boot/reuse to the `om-prepare-test-env` skill and points APP_URL at the descriptor it writes. Use when the user says "run integration tests", "run e2e tests", "test this feature", "create test for", "convert test case", "run QA tests", or "integration test".
---

# Integration Tests Skill

The executable browser suite is `e2e/`, a standalone npm project on the e2e runner. Each test states goals in natural language, an agent executes them in a real browser, and deterministic checks (URL, API read-back, exact values) pin the outcome. This skill adds tests there, runs them, and reports failures with artifact-based diagnosis. A markdown scenario (`.ai/qa/scenarios/TC-*.md`) is optional.

**Environment boot/reuse is not this skill's job.** Discovering, provisioning, reusing, and locking the test environment live in `om-prepare-test-env` (`.agents/skills/om-prepare-test-env/SKILL.md` plus the repo rules in `.ai/skills/om-prepare-test-env/SKILL.md`). It writes `.ai/qa/test-env.json`; this skill reads `baseUrl` from it and passes it as `APP_URL`. The suite talks to the app over HTTP only, so `APP_URL` is the whole contract.

## Quick Reference

All commands run inside `e2e/`.

| Action | Command |
|--------|---------|
| One-time setup | `npm install && npx @e2e-dev/web install chromium` |
| Whole suite | `APP_URL=<baseUrl> npm test` (needs `AI_GATEWAY_API_KEY`; `E2E_MODEL` overrides the model) |
| One file | `npm test -- auth.e2e.ts` |
| One area | `npm test -- --tag crm` |
| List what would run | `npm run list` |
| Watch the browser | `npm run test:headed` |
| Ignore cached agent steps | `npm run test:live` |
| Typecheck tests | `npm run typecheck` |
| Report | `.e2e/report.json`; failure screenshots and traces under `.e2e/artifacts/` |
| Tests | `tests/<area>.e2e.ts` (`auth`, `crm`, `catalog`, `sales`, `admin`) |
| Scenario sources (optional) | `.ai/qa/scenarios/TC-*.md` |
| Env descriptor | `.ai/qa/test-env.json` (written by `om-prepare-test-env`); CLI state in `.ai/qa/ephemeral-env.json` |
| Create-app parity | `yarn test:create-app:integration` (repo root) |

## Suite Layout

| File | Role |
|------|------|
| `e2e.config.ts` | One web target at `APP_URL` (default `http://localhost:3000`), the QA agent (model, persona, Open Mercato vocabulary under `context`), `credentials` for the demo personas, `secrets` for passwords the suite creates. Generous timeouts because dev-mode Next.js compiles on first visit. |
| `tests/auth.setup.e2e.ts` | Signs in `admin` and `employee` once with deterministic `screen` calls and saves both sessions. |
| `tests/support/api.ts` | `OmApi`: form login, bearer token cache, `request`, `list`, `create` (tracks for cleanup), `track`, `cleanup`; `idFromUrl` pulls the uuid off a detail page URL. |
| `tests/support/fixtures.ts` | Fixtures `api` (admin client, cleaned up after the test), `apiAs(persona)`, `stamp` (run-unique prefix); `noticeAckCookies`; re-exports `expect`, `credentials`, `secrets`, `unique` from `e2e`. |
| `tests/<area>.e2e.ts` | `test.describe('<area>', { tags: ['<area>'], session: 'admin' }, ...)`; each title starts with the `TC-...` id. |

## Anatomy of a Test

```ts
import { test, expect, unique } from './support/fixtures';
import { idFromUrl } from './support/api';

const COMPANIES = '/api/customers/companies';

test.describe('crm', { tags: ['crm'], session: 'admin' }, () => {
  test('TC-CRM-003 edits a company name and website', async ({ app, agent, api, stamp }) => {
    const original = `${stamp} Original`;
    const renamed = `${stamp} Renamed`;
    const companyId = await api.create(COMPANIES, { displayName: original });
    await app.open(`/backend/customers/companies-v2/${companyId}`);

    await agent.act('Rename this company to {name} and set its website to {website}. Save the change.', {
      params: { name: unique(renamed), website: 'https://renamed.example.com' },
    });
    await agent.assert(`the company is now called "${renamed}"`);

    await expect
      .poll(async () => {
        const items = await api.list<{ id: string; display_name: string }>(`${COMPANIES}?search=${encodeURIComponent(renamed)}&pageSize=20`);
        return items.find((item) => item.id === companyId)?.display_name ?? null;
      }, { timeout: 30_000 })
      .toBe(renamed);
  });
});
```

Building blocks:

- `app.open(path)` navigates; `session: 'admin'` on the describe (or test) restores the saved session.
- `agent.act(goal, { params })` for the flow; `agent.assert(claim)` for what the screen should show; `agent.extract(question, { schema })` with a zod schema when a value is needed.
- Run-unique values come from `stamp` and go into `params` wrapped in `unique(...)`, so the agent step cache replays them across runs. Static values are plain strings.
- Deterministic anchors around agent steps: `expect(browser).toHaveURL(regex)`, `screen.getByText(...)`, `screen.getByRole(...)`, `expect.poll` over `api.list`.
- Fixtures: `api.create(path, body)` seeds and tracks; `api.track(path, idFromUrl(await browser.url()))` for records the UI created; `apiAs('employee')` for another persona. Cleanup is `DELETE <path>?id=<id>`; routes that delete by path segment (dictionaries) call `api.request('DELETE', ...)` themselves.
- Passwords: `credentials.user('admin').password`, `secrets.get('new-user-password')`. Never a literal.
- Tests that must log out sign in on their own: logout revokes the server session, which would sign every later consumer of a saved session out.

## Workflow

### Phase 1 - Identify What to Test

Sources in priority order: a spec in `.ai/specs/*.md` or `.ai/specs/enterprise/*.md`, the user's description, or the recent diff. For each flow note the area (`auth`, `crm`, `catalog`, `sales`, `admin`), the persona, the priority (High for CRUD happy paths and auth, Medium for validation and settings, Low for cosmetic edges).

### Phase 2 - Find the Next TC Number

```bash
ls .ai/qa/scenarios/TC-{CATEGORY}-*.md 2>/dev/null | sort | tail -1
grep -rhoE "TC-{CATEGORY}-[0-9]{3}" e2e/tests | sort -u | tail -1
```

Use the highest number from either source, plus one.

### Phase 3 - Attach to the Test Environment

Read `.ai/qa/test-env.json`; when it is `status: running` and valid, use its `baseUrl` as `APP_URL`. Otherwise invoke `om-prepare-test-env`, which boots or reuses the ephemeral env (`yarn test:ephemeral:start`) and writes the descriptor. Never guess `localhost:<port>`.

### Phase 4 - Explore the Flow

Walk the flow once before writing: through the browser provider in `.ai/browsers/`, through the `e2e` MCP server (`open_session` against `e2e/e2e.config.ts`, then `observe`/`locate`), or with `npm run test:headed` on a draft. Record the exact labels, button text, placeholders, the URL after submit, and any dialogs. For API read-back, confirm the endpoint and response shape with cURL (login is form-encoded).

### Phase 5 - Write the Test

- Add it to the existing `tests/<area>.e2e.ts`. A new area means a new file with its own tag and, if needed, a new `.ai/qa/scenarios` category; ask first.
- Goals name what the user wants, not clicks: "Create a new company named {name}. Submit the form." Page vocabulary (routes, button labels, combobox behaviour) belongs in the agent `context` in `e2e.config.ts` so every test benefits.
- Pin the outcome deterministically after each agent step. An `agent.assert` alone is a claim; pair it with a URL check, a `screen` locator, or an API read-back.
- No hardcoded ids; resolve through `api.create` or `idFromUrl`.
- Track everything the UI creates so `api.cleanup()` removes it.

### Phase 6 - Optionally Write the Scenario

Create `.ai/qa/scenarios/TC-{CATEGORY}-{XXX}-{slug}.md` with the template in `.ai/qa/AGENTS.md`, filled with the steps observed in Phase 4.

### Phase 7 - Verify

```bash
cd e2e
npm run typecheck
APP_URL=<baseUrl> npm test -- <area>.e2e.ts
```

A new test runs the model on its first pass (needs `AI_GATEWAY_API_KEY`). Run it twice: the second pass should replay from `.e2e/cache/`. Fix flakes before finishing; do not leave broken tests.

### Create-App / Standalone Parity

When the change touches `packages/create-app`, scaffolding, or CLI behaviour consumed by scaffolded apps, run `yarn test:create-app:integration` from the repo root. It builds the packages, scaffolds a temporary standalone app with the local tarballs, and runs that app's own ephemeral integration command.

### Failure Analysis and Reporting (mandatory on failures)

1. Read the console output for the failing test titles and the first assertion or agent error.
2. Open `.e2e/report.json` and the failing test's screenshots and trace in `.e2e/artifacts/` (`npx playwright-core@1.63.0 show-trace <file>`).
3. Classify: product regression, test issue (stale vocabulary, weak anchor, missing fixture or cleanup), or environment/data issue (app down, session drift, rate limit, leftover records).
4. Assign an owner: `User/Product team`, `Agent/QA`, or `Shared`.
5. Reply with this table before any narrative:

| Failing test | Evidence used | Reasoning | Suggested owner | Next action |
|--------------|---------------|-----------|-----------------|-------------|
| `<file>::<TC id title>` | `stdout + screenshot + trace` | `Concise diagnosis` | `User/Product team` / `Agent/QA` / `Shared` | `Concrete fix` |

An agent that truthfully reports it could not reach the goal is evidence, not noise: the first live runs found a real API-key listing bug this way (see `e2e/README.md`).

### Running-Only Mode

When asked only to run tests, skip the authoring phases, attach to the environment, run the requested file/tag/suite, and apply the failure analysis above.

## Rules

- MUST explore the running app before writing; never guess labels or flows
- MUST defer environment boot/reuse to `om-prepare-test-env` and take `APP_URL` from `.ai/qa/test-env.json`
- MUST put tests in `e2e/tests/<area>.e2e.ts` with the area tag and the `TC-...` id in the title
- MUST use saved sessions; only a test that logs out signs in itself
- MUST build names from `stamp` and pass them as `unique(...)` params
- MUST seed through `api.create` and track UI-created records so cleanup is exact
- MUST pair every `agent.assert` with a deterministic check
- MUST NOT hardcode record ids or passwords
- MUST NOT rely on seeded data beyond the demo accounts and the tenant facts listed in `e2e.config.ts`
- MUST verify the test passes before finishing, and report failures with the table above
- MUST keep shared vocabulary in `e2e.config.ts` `context` and shared helpers in `tests/support/`

## Deriving Scenarios from a Spec

| Spec section | Generates |
|--------------|-----------|
| UI/UX - each user flow | One test per flow |
| API Contracts - each endpoint | API read-back inside the UI test, or a Jest test when there is no UI |
| Edge Cases / Error Scenarios | One test per significant error path |
| Risks & Impact Review | Regression tests for documented failure modes |

A typical spec yields 3-8 tests. Happy paths first; edge cases as separate tests when they earn it.

## Batch Conversion

1. List unported scenarios: ids in `.ai/qa/scenarios/` minus ids found by `grep -rhoE "TC-[A-Z-]+-[0-9]{3}" e2e/tests | sort -u`
2. Port one area at a time
3. Run the area tag after each batch
4. Report converted, passed, failed

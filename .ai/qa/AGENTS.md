# QA Instructions

## Always

- Executable browser tests live in `e2e/tests/*.e2e.ts`, an agentic suite on the [e2e](https://e2e.dev) runner. Each test states goals in natural language, an agent drives a real browser, and deterministic checks (URL, API read-back, exact values) pin the outcome.
- Keep the `TC-...` id from `.ai/qa/scenarios` in the test title; one `describe` per area, tagged (`auth`, `crm`, `catalog`, `sales`, `admin`).
- Create fixtures and clean up through the `api` fixture (`e2e/tests/support/api.ts`). Everything created or tracked is deleted after the test, pass or fail.
- Use saved sessions (`{ session: 'admin' }`) instead of logging in; `tests/auth.setup.e2e.ts` signs the personas in once.
- Build run-unique names from the `stamp` fixture and pass them to `agent.act` as `unique(...)` params.
- Check `.ai/qa/ephemeral-env.json` before starting a new environment.

## Ask First

- Ask before applying migrations or resetting a developer's local database.
- Ask before adding tests that need live external services or secrets.
- Ask before adding a new area file (new tag) under `e2e/tests/`.

## Never

- Never rely on seeded records beyond the demo accounts and the demo tenant named in `e2e/e2e.config.ts`.
- Never put a password in a test; use `credentials.user(name).password` or `secrets.get(name)`.
- Never leave broken tests; fix them or `test.skip` with a reason.

## Quick Start

```bash
# App: ephemeral env (URL in .ai/qa/ephemeral-env.json) or the dev server on :3000
yarn test:ephemeral:start            # or yarn test:ephemeral:start:verbose, or yarn dev

cd e2e
npm install
npx @e2e-dev/web install chromium    # once

APP_URL=http://127.0.0.1:5001 npm test          # whole suite; needs a model key (AI_GATEWAY_API_KEY)
npm test -- auth.e2e.ts                         # one file
npm test -- --tag crm                           # one area
npm run list                                    # what would run
npm run test:headed                             # watch the browser
npm run test:live                               # ignore cached agent steps
```

Report: `e2e/.e2e/report.json`. Failures leave screenshots and a trace under `e2e/.e2e/artifacts/`. Passing `agent.act` steps are cached under `e2e/.e2e/cache/` and replay without a model call while the screens are unchanged.

Preferred local loop: boot once with `yarn test:ephemeral:start`, reuse the URL from `.ai/qa/ephemeral-env.json`, run `/om-integration-tests` against it.

---

## Directory Structure

```
.ai/qa/
├── AGENTS.md                # This file
├── scenarios/               # TC-*.md scenario descriptions (source of the TC ids)
└── ephemeral-env.json       # CLI-owned state of the running ephemeral app

e2e/
├── e2e.config.ts            # web target at APP_URL, QA agent persona and vocabulary, demo credentials, secrets
├── tests/auth.setup.e2e.ts  # signs in admin and employee once, saves both sessions
├── tests/support/api.ts     # REST client for fixtures, read-back, cleanup
├── tests/support/fixtures.ts# api, apiAs(persona), stamp fixtures; re-exports expect, credentials, secrets, unique
└── tests/*.e2e.ts           # one file per area: auth, crm, catalog, sales, admin
```

See `e2e/README.md` for the full picture and the `om-integration-tests` skill for writing tests.

---

## Scenarios

Markdown scenarios (`.ai/qa/scenarios/TC-*.md`) are the id source and optional reference material. Tests can be written from a spec, a scenario, or a feature description; when a scenario exists, carry its id in the test title and mention it in the file's header comment.

---

## Two Testing Modes

### 1. Executable e2e tests (preferred)

`e2e/tests/*.e2e.ts`, run with `npm test` inside `e2e/`. A model key is needed for uncached steps; cached steps replay for free.

### 2. Manual AI-driven QA (Playwright MCP)

An agent reads a scenario or spec and executes it interactively through the browser provider in `.ai/browsers/`. Use it for exploration and to discover the flow before writing an e2e test.

---

## Ephemeral Environment

```bash
yarn test:ephemeral:start            # app + isolated database, no dev server needed, Docker required
yarn test:ephemeral:start:verbose
```

- State is written to `.ai/qa/ephemeral-env.json` (`baseUrl`, `port`, `databaseUrl`); never edit it by hand
- Default app port is `5001`; a free fallback port is used when it is busy
- The file is cleared when the environment stops
- Reuse, TTL, and teardown rules live in the `om-prepare-test-env` skill

---

## How to Create New Tests

### Option A: `/om-integration-tests` skill (recommended)

Reads the spec or scenario, explores the running app, writes the test in the right area file, runs it.

### Option B: Manual

1. Read the spec (`.ai/specs/*.md`), the scenario (`.ai/qa/scenarios/TC-*.md`), or the feature description.
2. Explore the flow through the browser provider against the URL from `.ai/qa/ephemeral-env.json`; note labels, button text, the URL after submit.
3. Add a test to the matching `e2e/tests/<area>.e2e.ts`:

```ts
test('TC-CRM-001 creates a company and finds it in the list', async ({ app, agent, api, stamp, browser }) => {
  const name = `${stamp} Company`;
  await app.open('/backend/customers/companies');
  await agent.act('Create a new company named {name}. Submit the form.', { params: { name: unique(name) } });
  await expect(browser).toHaveURL(/\/backend\/customers\/companies-v2\/[0-9a-f-]{36}$/i, { timeout: 60_000 });
  api.track('/api/customers/companies', idFromUrl(await browser.url()));
  await agent.assert(`the company detail page for "${name}" is showing`);
});
```

4. Verify: `cd e2e && APP_URL=<url> npm test -- <area>.e2e.ts`.

### Executable Test Rules

- Natural-language goals for the agent, deterministic checks for the outcome (`expect(browser).toHaveURL`, `screen.getBy*`, `api.list` read-back, `agent.extract` with a zod schema)
- Seed through `api.create` when the flow needs an existing record; track UI-created records with `api.track`
- Independent, order-free, safe across retries; no hardcoded ids
- New page vocabulary goes into the agent `context` in `e2e/e2e.config.ts`, not into the goal text

---

## How to Test Manually

### UI

Drive the browser provider (`.ai/browsers/`): navigate, snapshot, interact, verify. Use the ephemeral URL.

### API (cURL)

```bash
# Login (form-encoded; a JSON body is rejected with 400)
curl -X POST http://127.0.0.1:<port>/api/auth/login \
  -d 'email=admin@acme.com&password=secret'

# Authenticated request
curl http://127.0.0.1:<port>/api/customers/companies \
  -H "Authorization: Bearer <token>"
```

---

## Default Credentials

Created by `mercato init`:

| Role | Email | Password |
|------|-------|----------|
| Superadmin | `superadmin@acme.com` | `secret` |
| Admin | `admin@acme.com` | `secret` |
| Employee | `employee@acme.com` | `secret` |

Superadmin spans all tenants, admin has full access within the organization, employee is role-limited. Login is rate limited (5 attempts / 60 s per email), which is why the suite uses saved sessions.

---

## Results Presentation

### Executable suite

- Console summary from `npm test`
- `e2e/.e2e/report.json` for machines
- `e2e/.e2e/artifacts/` for screenshots and traces of failures

### Manual runs

| Test ID | Test Name | Status | Notes |
|---------|-----------|--------|-------|
| TC-AUTH-001 | User Login Success | PASS | |
| TC-AUTH-003 | Remember Me | FAIL | Session not persisted |

Then totals (total, passed, failed, skipped, pass rate) and, per failure: test id, failing step, expected, actual, evidence.

---

## How to Manage Scenarios

Scenarios live in `.ai/qa/scenarios/`.

### Naming Convention

```
TC-[CATEGORY]-[XXX]-[title].md
```

- **CATEGORY**: code from the table below
- **XXX**: 3-digit sequential number
- **title**: kebab-case

### Category Codes

| Code | Category |
|------|----------|
| AUTH | Authentication & User Management |
| CAT | Catalog Management |
| SALES | Sales Management |
| CRM | Customer/CRM Management |
| ADMIN | System Administration |
| INT | Integration Scenarios |
| TRANS | Translations & Localisation |
| AUD | Audit Logs |
| CUR | Currencies & Exchange Rates |
| STAFF | Staff & Team Management |
| DICT | Dictionaries |
| DIR | Directory (Organisations & Tenants) |
| API-SYS | System & Maintenance APIs |
| API-ENT | Custom Fields & Entities APIs |
| API-BULK | Bulk Operations APIs |
| API-AUD | Audit & Business Rules APIs |
| API-SEARCH | Search & Lookup APIs |
| API-FT | Feature Toggles APIs |
| API-VIEW | Perspectives & Views APIs |
| API-ONBOARD | Onboarding APIs |
| API-AUTH | API Authentication & Security |
| API-ERR | API Error Handling & Edge Cases |
| API-DASH | Dashboard & Widget APIs |
| API-DOCS | OpenAPI & Documentation APIs |

### Scenario Template

```markdown
# Test Scenario [NUMBER]: [TITLE]

## Test ID
TC-[CATEGORY]-[XXX]

## Category
[Category Name]

## Priority
[High/Medium/Low]

## Type
[UI Test / API Test]

## Description
[What this test validates]

## Prerequisites
- [Prerequisite]

## API Endpoint (for API tests)
`[METHOD] /api/path`

## Test Steps
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | [Action] | [Expected] |

## Expected Results
- [Outcome]

## Edge Cases / Error Scenarios
- [Edge case]
```

### Best Practices

1. One scenario per file
2. List every prerequisite
3. Actionable steps, verifiable results
4. Include edge cases
5. Set priority: High for critical paths, Medium for standard flows, Low for edge cases

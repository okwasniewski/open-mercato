# Test Architecture - Open Mercato

## Frameworks

| Framework | Purpose | Config |
|-----------|---------|--------|
| Jest + ts-jest | Unit and component tests | `jest.config.cjs` (root + 17 packages + 1 app) |
| e2e (https://e2e.dev) | Agentic browser tests | `e2e/e2e.config.ts`, standalone npm project in `e2e/` |

## File Counts (approximate)

- Unit/component tests: ~485 files (`*.test.ts`, `*.test.tsx`)
- e2e tests: one file per area under `e2e/tests/`; `cd e2e && npm run list` gives the current test count

## Test File Conventions

```
packages/<pkg>/src/modules/<module>/
  __tests__/
    *.test.ts        # Jest unit tests
    *.test.tsx       # React component tests

e2e/
  e2e.config.ts            # target, agent persona and vocabulary, credentials, secrets
  tests/auth.setup.e2e.ts  # saves the admin and employee sessions
  tests/support/api.ts     # REST client for fixtures and cleanup
  tests/support/fixtures.ts
  tests/<area>.e2e.ts      # describe('<area>', { tags: ['<area>'], session: 'admin' })
```

## Module Path Extraction

Find `/modules/<name>/` in the path:

| File path | Module |
|-----------|--------|
| `packages/core/src/modules/customers/lib/foo.ts` | `customers` |
| `packages/core/src/modules/sales/api/...` | `sales` |
| `apps/mercato/src/modules/pos/page.tsx` | `pos` |
| `packages/enterprise/src/modules/enterprise_pricing/...` | `enterprise_pricing` |

## Module to e2e Tag

| Changed module | Tag | File |
|----------------|-----|------|
| `auth` (login, logout, sessions) | `auth` | `e2e/tests/auth.e2e.ts` |
| `auth` (users, roles), `api_keys`, `dictionaries` | `admin` | `e2e/tests/admin.e2e.ts` |
| `customers` | `crm` | `e2e/tests/crm.e2e.ts` |
| `catalog` | `catalog` | `e2e/tests/catalog.e2e.ts` |
| `sales` | `sales` | `e2e/tests/sales.e2e.ts` |

`auth` changes run both `auth` and `admin`. Modules not listed have no browser coverage yet; report them. Keep this table in step with `e2e/tests/` when an area file is added.

Cross-area dependencies (apply for `api-logic`, `data`, `mixed` layers):

| Changed module | Also run |
|----------------|----------|
| `customers` | `sales` (documents pick a customer) |
| `catalog` | `sales` |
| `auth` | every tag relying on saved sessions; prefer the whole suite when login or session code changed |

## Wide-Scope Triggers (run everything)

- `packages/shared/`, `packages/events/`, `packages/queue/`, `packages/cache/`
- `jest.config.`, `jest.setup.`, `tsconfig`, root `package.json`, `turbo.json`
- `packages/ui/src/backend/` (shared backend components): Jest related tests, whole e2e suite
- `e2e/e2e.config.ts` or `e2e/tests/support/`: whole e2e suite

## Layer Classification (controls whether e2e runs)

### UI layer: Jest only, skip e2e

| Pattern | Examples |
|---------|---------|
| `**/*.css` | Global stylesheets |
| `packages/ui/src/primitives/**` | Button.tsx, Badge.tsx |
| `packages/ui/src/styles/**` | CSS variables, Tailwind config |

### UI-Component layer: Jest + e2e

| Pattern | Examples |
|---------|---------|
| `packages/ui/src/backend/**/*.tsx` | `DataTable.tsx`, `FlashMessages.tsx` |
| `**/frontend/**` | Next.js frontend pages |
| `**/backend/**/*.tsx` | Next.js backoffice pages |
| `**/components/**` | React components |
| `**/widgets/**` | Widget injections |

`backend/page.tsx` is a page (ui-component); `api/GET/route.ts` is an API route (api-logic).

### API-Logic layer: Jest + e2e

`**/api/**`, `**/commands/**`, `**/lib/**`, `**/services/**`, `**/subscribers/**`, `**/workers/**`, `**/events.ts`, `**/notifications.ts`, `**/ai-tools.ts`

### Data layer: Jest + e2e

`**/data/entities*`, `**/data/migrations*`, `**/data/validators*`, `**/data/extensions*`, `**/data/enrichers*`

### Decision rule

```
layer = ui        -> only if ALL changed files match UI patterns
layer = data      -> if ANY changed file matches data patterns
layer = api-logic -> if ANY matches api-logic (and none data)
layer = mixed     -> changes span several layers
```

## Jest Run Commands

```bash
yarn test                              # All Jest tests (turbo)
yarn jest --findRelatedTests <files>   # Related tests for specific files
yarn jest <file>                       # Single test file
yarn workspace @open-mercato/core test # Single package
```

## e2e Run Commands

```bash
cd e2e
npm install && npx @e2e-dev/web install chromium   # once
APP_URL=<url> npm test                             # whole suite (AI_GATEWAY_API_KEY for uncached steps)
npm test -- --tag crm                              # one area
npm test -- crm.e2e.ts                             # one file
npm run list                                       # what would run
```

Report: `e2e/.e2e/report.json`. The app comes from `yarn test:ephemeral:start` (URL in `.ai/qa/ephemeral-env.json`) or `yarn dev`.

## CI Pipeline

1. `yarn test`: all Jest tests (every PR)

## Environment Variables Affecting Test Selection

| Variable | Effect |
|----------|--------|
| `OM_ENABLE_ENTERPRISE_MODULES=true` | Enables enterprise modules in the booted app |
| `AI_GATEWAY_API_KEY` / `E2E_MODEL` | Model for uncached agent steps in the e2e suite |

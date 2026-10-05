---
name: om-smart-test
description: Run only the tests affected by changed code. Use when the user says "run affected tests", "run smart tests", "test only what changed", "run tests for this PR", "run tests for my changes", "selective tests", or asks to run tests without running the full suite.
---

# Smart Test - Run Only Affected Tests

Runs the minimal set of tests that cover the code changes in the current branch or working tree.

**Execution policy**: display the plan (which tests run and why), then run them without asking.

**Cache**: the plan is persisted to `.test-cache.json` (gitignored). On a repeat invocation for the same commit with no uncommitted changes, the cached plan runs as is.

## Two Test Types, Two Strategies

| Type | Files | Strategy |
|------|-------|----------|
| Jest (unit/component) | `*.test.ts`, `*.test.tsx` | `--findRelatedTests` (Jest walks the import graph) |
| e2e (browser) | `e2e/tests/<area>.e2e.ts` | Changed module -> area tag; run `npm test -- --tag <area>` inside `e2e/` |

---

## Step 0 - Cache Lookup

```bash
CURRENT_HASH=$(git rev-parse HEAD)
UNCOMMITTED=$(git diff --name-only HEAD; git ls-files --others --exclude-standard)
```

Read `.test-cache.json`. It is valid when `commitHash` equals `CURRENT_HASH`, `UNCOMMITTED` is empty, and `git merge-base --is-ancestor <cache.commitHash> HEAD` exits 0 (guards against rebase, amend, force-push).

**Valid cache**: print `[cache hit: <hash>]`, skip Steps 1-2, and run:
- Jest: `yarn jest --findRelatedTests <cache.jestSourceFiles> --passWithNoTests`
- e2e: if `cache.e2eWide` is `true`, `npm test`; else one `npm test -- --tag <tag>` per entry in `cache.e2eTags`; else skip.

**Invalid or missing**: continue to Step 1 and save the plan after Step 2.

### Cache file format (`.test-cache.json`)

```json
{
  "commitHash": "<git rev-parse HEAD>",
  "savedAt": "<ISO timestamp>",
  "scope": "module | wide | test-only | package",
  "layer": "ui | ui-component | api-logic | data | mixed",
  "affectedModules": ["auth", "sales"],
  "jestSourceFiles": ["packages/core/src/modules/auth/commands/users.ts"],
  "e2eTags": ["auth", "sales"],
  "e2eWide": false
}
```

`layer` values: `ui` = skip e2e; `ui-component`, `api-logic`, `data`, `mixed` = run e2e.

### Save Cache

```bash
node -e "
const fs = require('fs');
const plan = {
  commitHash: '$(git rev-parse HEAD)',
  savedAt: new Date().toISOString(),
  scope: '<scope>',
  layer: '<ui|ui-component|api-logic|data|mixed>',
  affectedModules: <json-array-of-modules>,
  jestSourceFiles: <json-array>,
  e2eTags: <json-array>,
  e2eWide: <true|false>
};
fs.writeFileSync('.test-cache.json', JSON.stringify(plan, null, 2));
"
```

---

## Step 1 - Determine Changed Files

Build one changed-file list and reuse it for cache invalidation, classification, Jest, and the e2e tag mapping. Include the PR diff, local changes, and untracked files.

Resolve the comparison base first. Do not guess `origin/main` when the branch is based on `develop`; that can pull unrelated `packages/shared/` changes into the diff and force the full suite.

```bash
BASE_REF="${SMART_TEST_BASE_REF:-}"
if [ -z "$BASE_REF" ]; then
  BASE_REF="$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || true)"
fi
if [ -z "$BASE_REF" ] && git rev-parse --verify --quiet origin/develop >/dev/null; then
  if git merge-base --fork-point origin/develop HEAD >/dev/null 2>&1 || git merge-base --is-ancestor origin/develop HEAD; then
    BASE_REF="origin/develop"
  fi
fi
if [ -z "$BASE_REF" ] && git rev-parse --verify --quiet develop >/dev/null; then
  if git merge-base --fork-point develop HEAD >/dev/null 2>&1 || git merge-base --is-ancestor develop HEAD; then
    BASE_REF="develop"
  fi
fi

CHANGED_FILES=$({
  if [ -n "$BASE_REF" ]; then
    git diff --name-only "$BASE_REF"...HEAD
  fi
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | awk '!seen[$0]++')
```

If `git diff --name-only origin/main...HEAD` contains `packages/shared/` but the resolved develop base diff does not, report a base-ref mismatch and keep the develop base; do not classify as wide scope.

---

## Step 2 - Classify Scope and Layer

### 2a - Scope

- **Wide scope** (run everything): `packages/shared/`, `packages/events/`, `packages/queue/`, `packages/cache/`, root `jest.config.cjs`, `jest.setup.ts`, `tsconfig*.json`, root `package.json`, `turbo.json`
- **UI-wide** (`packages/ui/src/backend/`): shared components on every backend page. Jest: `--findRelatedTests`; e2e: whole suite. For `packages/ui/src/primitives/` or `packages/ui/src/styles/` only, classify as `ui` layer instead (no e2e).
- **Module-scoped**: `packages/*/src/modules/<module>/` or `apps/mercato/src/modules/<module>/`; extract `<module>`
- **Package-scoped** (no module): `packages/<pkg>/src/lib/` or `packages/<pkg>/src/` root; wide scope for that package
- **Jest-test-only**: only `.test.ts`/`.test.tsx` changed; run those files, skip e2e
- **e2e-test-only**: only files under `e2e/` changed; run the changed `e2e/tests/*.e2e.ts` files (`npm test -- <file>`), or the whole suite when `e2e.config.ts` or `tests/support/` changed; skip Jest

See `references/test-architecture.md` for module extraction and the module-to-tag map.

### 2b - Layer (decides whether e2e runs)

| Layer | Path indicators | e2e needed? |
|-------|----------------|-------------|
| `ui` | `**/*.css`, `packages/ui/src/primitives/`, `packages/ui/src/styles/` | No |
| `ui-component` | `packages/ui/src/backend/**/*.tsx`, `/components/`, `/widgets/`, `/frontend/`, `/backend/**/*.tsx` (Next.js pages) | Yes: the agent drives full pages; a broken render or a renamed button changes the flow |
| `api-logic` | `/api/`, `/commands/`, `/lib/`, `/services/`, `/subscribers/`, `/workers/`, `events.ts`, `notifications.ts`, `ai-tools.ts` | Yes |
| `data` | `/data/entities`, `/data/migrations`, `/data/validators`, `/data/extensions`, `/data/enrichers` | Yes |

Decision rule, set `$LAYER`:
- All files `ui` -> `LAYER=ui`, skip e2e
- Any `data` -> `LAYER=data`
- Any `api-logic` (none `data`) -> `LAYER=api-logic`
- Any `ui-component` (none `api-logic`/`data`) -> `LAYER=ui-component`
- Several non-`ui` layers -> `LAYER=mixed`
- Wide scope -> run everything

Special cases: module `backend/page.tsx` is `ui-component`; `api/GET/route.ts` is `api-logic`.

Save the cache now (with `layer`, `e2eTags`, `e2eWide`).

---

## Step 3 - Jest Unit Tests

```bash
CHANGED=$(printf '%s\n' "$CHANGED_FILES" \
  | grep -E '\.(ts|tsx)$' \
  | grep -v '\.test\.' \
  | grep -v '__tests__/' \
  | grep -v '^e2e/' \
  | tr '\n' ' ')

yarn jest --findRelatedTests $CHANGED --passWithNoTests
```

Wide scope: `yarn test` instead.

---

## Step 4 - Ensure an App Is Running (e2e only)

The suite needs a running Open Mercato at `APP_URL` and a model key for uncached agent steps.

1. Read `.ai/qa/ephemeral-env.json`; when it reports `status: running`, use its `baseUrl`.
2. Else probe the dev server: `curl -sf http://localhost:3000/login`.
3. Else boot an ephemeral app: `yarn test:ephemeral:start` (Docker required), then read the URL from `.ai/qa/ephemeral-env.json`. Reuse and teardown rules live in the `om-prepare-test-env` skill.

Leave the environment running afterwards.

If `AI_GATEWAY_API_KEY` is not set, say so in the plan: the run can only replay cached agent steps, and any step the app changed under will fail with a model error rather than a product finding.

---

## Step 5 - e2e Tests

**Layer gate**: `LAYER=ui` skips this step.

Map each affected module to an area tag with the table in `references/test-architecture.md` (`auth` -> `auth`, `customers` -> `crm`, `catalog` -> `catalog`, `sales` -> `sales`, `api_keys`/`dictionaries`/`auth` users and roles -> `admin`). Modules without a tag have no browser coverage yet; list them in the report.

```bash
cd e2e
if [ "$E2E_WIDE" = "true" ]; then
  APP_URL="$APP_URL" npm test
elif [ -n "$E2E_TAGS" ]; then
  for tag in $E2E_TAGS; do APP_URL="$APP_URL" npm test -- --tag "$tag"; done
else
  echo "No affected e2e tests."
fi
```

`npm run list -- --tag <tag>` previews a tag. Wide scope and `packages/ui/src/backend/` changes set `E2E_WIDE=true`.

Cross-module effects: `sales` flows create customers and read the catalog, so a `customers` or `catalog` change with `LAYER=api-logic`, `data`, or `mixed` also runs the `sales` tag. With `LAYER=ui-component` only the changed module's own tag runs.

---

## Step 6 - Report Results

- Cache hit or fresh analysis
- Jest: related tests vs full suite
- e2e: which tags ran and which changed module triggered each; modules without browser coverage
- Whether the app was already running, which URL, and whether a model key was available
- Any wide-scope fallback and why

Coverage table (always):

| Type | Ran | Total | % |
|------|-----|-------|---|
| Unit (Jest suites) | `<ran>` | ~485 | `<ran/485 * 100>`% |
| e2e tests | `<ran>` | `<npm run list>` | `<ran/total * 100>`% |

Take the e2e total from `npm run list` inside `e2e/`; read failures from `e2e/.e2e/report.json`.

---

## Decision Tree

```
Step 0: .test-cache.json valid (hash + no uncommitted + reachable)?
  YES -> run from cache: Jest cached files; e2e whole suite when e2eWide, else cached tags, else skip
  NO  -> analyze:

    Step 2a - Scope:
      Only .test.ts/.test.tsx?           -> Jest: those files; e2e: skip
      Only files under e2e/?             -> Jest: skip; e2e: changed files (or whole suite for config/support)
      shared/events/queue/cache/config?  -> yarn test + whole e2e suite
      packages/ui/src/backend/?          -> Jest: --findRelatedTests; e2e: whole suite
      Module-scoped?                     -> extract module name(s)
      Package lib (no module)?           -> --findRelatedTests for that package

    Step 2b - Layer:
      ALL files CSS / tokens / primitives?       -> LAYER=ui, e2e skip
      ANY ui-component / api-logic / data?       -> LAYER=<...>, map modules to tags, ensure app, run tags

    Set $LAYER -> save cache -> run tests
```

---

## Reference Files

- `references/test-architecture.md`: test layout, module path patterns, module-to-tag map, run commands

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// The standalone lanes serve a PRODUCTION build (`yarn start`), so NODE_ENV is
// `production` inside the server process no matter what the app .env says.
// `urlForCustomerOrg` refuses to fall back to a localhost portal URL there, so
// every customer-portal email (invitations, magic links, password resets) throws
// unless PLATFORM_PORTAL_BASE_URL is pinned - the invite routes turn that throw
// into a 502.
//
// The captured-email file, OM_ENABLE_PUSH_STUB_ADAPTER and the documents
// collaboration pair have the same shape of problem: the app reads them from its
// own .env while the queue-drain children spawned by the ephemeral runner do not
// read that file. The workflow lanes only run the app, so each variable must
// appear once there; the local parity script also feeds the ephemeral runner
// process, so it must set every variable on both sides.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

const REQUIRED_VARIABLES = [
  'PLATFORM_PORTAL_BASE_URL',
  'OM_TEST_EMAIL_CAPTURE_PATH',
  'OM_ENABLE_PUSH_STUB_ADAPTER',
  // NEXT_PUBLIC_DOCUMENTS_COLLAB_URL is inlined into the bundle at build time, so the
  // app .env copy is what the browser sees. DOCUMENTS_COLLAB_JWT_SECRET_V2 has to match
  // the sidecar: the app mints the collaboration token and the sidecar verifies it.
  'NEXT_PUBLIC_DOCUMENTS_COLLAB_URL',
  'DOCUMENTS_COLLAB_JWT_SECRET_V2',
]

// Variables that must be set exactly ONCE per lane, on the standalone app's .env side
// only. OM_DOCUMENTS_COLLAB_INTEGRATION is the permission that lets
// resolveDocumentsCollaborationEndpoint() accept the loopback ws:// URL above under
// NODE_ENV=production; in a test process the same variable used to gate a heavy
// realtime spec, so it stays app-side.
const APP_ONLY_VARIABLES = ['OM_DOCUMENTS_COLLAB_INTEGRATION']

const WORKFLOW_LANES = [
  '.github/workflows/snapshot.yml',
  '.github/workflows/npm-snapshot-preview.yml',
]
const SCRIPT_LANES = ['scripts/test-create-app-integration.ts']
const STANDALONE_LANES = [...WORKFLOW_LANES, ...SCRIPT_LANES]

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...relativePath.split('/')), 'utf8')
}

function countAssignments(source: string, variable: string): number {
  const matches = source.matchAll(new RegExp(`${variable}['"]?\\s*[:=]\\s*\\S`, 'g'))
  return Array.from(matches).length
}

for (const lane of WORKFLOW_LANES) {
  for (const variable of REQUIRED_VARIABLES) {
    test(`${lane} pins ${variable} for the app process`, () => {
      const source = readRepoFile(lane)
      assert.ok(
        countAssignments(source, variable) >= 1,
        `${lane} must set ${variable} in the standalone app .env`,
      )
    })
  }
}

for (const lane of SCRIPT_LANES) {
  for (const variable of REQUIRED_VARIABLES) {
    test(`${lane} pins ${variable} for both the app and the ephemeral runner processes`, () => {
      const source = readRepoFile(lane)
      assert.ok(
        countAssignments(source, variable) >= 2,
        `${lane} must set ${variable} for the standalone app .env AND the ephemeral runner env; the two run in different processes with different working directories`,
      )
    })
  }
}

for (const lane of STANDALONE_LANES) {
  for (const variable of APP_ONLY_VARIABLES) {
    test(`${lane} pins ${variable} for the app process only`, () => {
      const source = readRepoFile(lane)
      assert.equal(
        countAssignments(source, variable),
        1,
        `${lane} must set ${variable} exactly once, on the standalone app .env side`,
      )
    })
  }
}

test('PLATFORM_PORTAL_BASE_URL is documented for scaffolded apps', () => {
  for (const envExample of ['apps/mercato/.env.example', 'packages/create-app/template/.env.example']) {
    assert.match(
      readRepoFile(envExample),
      /PLATFORM_PORTAL_BASE_URL/,
      `${envExample} must document PLATFORM_PORTAL_BASE_URL — production deployments that omit it fail every customer-portal email`,
    )
  }
})

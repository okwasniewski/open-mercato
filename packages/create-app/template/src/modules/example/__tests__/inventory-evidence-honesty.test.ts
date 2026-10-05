/** @jest-environment node */
/**
 * Keeps `integrationTestPaths` honest: every entry is a real unit test under `__tests__/**`.
 * Browser and API scenarios live in the repository e2e suite under `e2e/` and are not tracked
 * per capability, so a populated field is unit-test evidence only.
 */
import fs from 'node:fs'
import path from 'node:path'

type Capability = {
  capabilityId: string
  integrationTestPaths: string[]
}

const moduleRoot = path.join(__dirname, '..')
const inventory = JSON.parse(
  fs.readFileSync(path.join(moduleRoot, 'references', 'surface-inventory.json'), 'utf8'),
) as { generatedNote: string; capabilities: Capability[] }

const isUnitTest = (entry: string) => entry.includes('/__tests__/')

describe('surface inventory evidence honesty', () => {
  it('documents that integrationTestPaths holds unit-test evidence only', () => {
    expect(inventory.generatedNote).toContain('The field holds unit tests only')
  })

  it('lists only unit test files under integrationTestPaths, never source or e2e specs', () => {
    const offenders: string[] = []
    for (const capability of inventory.capabilities) {
      for (const entry of capability.integrationTestPaths ?? []) {
        if (!isUnitTest(entry)) {
          offenders.push(`${capability.capabilityId} → ${entry}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('points every evidence entry at a file that exists', () => {
    const missing: string[] = []
    for (const capability of inventory.capabilities) {
      for (const entry of capability.integrationTestPaths ?? []) {
        // Inventory paths are app-root relative (`src/modules/example/...`).
        const absolute = path.join(moduleRoot, '..', '..', '..', entry)
        if (!fs.existsSync(absolute)) missing.push(`${capability.capabilityId} → ${entry}`)
      }
    }
    expect(missing).toEqual([])
  })
})

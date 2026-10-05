import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeHarnessManifest, generateShared } from './shared.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const AGENTIC_SHARED_DIR = join(__dirname, '..', '..', '..', 'agentic', 'shared')

test('agentic setup installs the emitted pin without refreshing its ownership manifest', () => {
  const wizardSource = readFileSync(join(__dirname, '..', 'wizard.ts'), 'utf8')
  assert.match(wizardSource, /spawnSync\(process\.execPath, \[installScript\]/)
  assert.doesNotMatch(wizardSource, /spawnSync\(process\.execPath, \[installScript, '--update'\]/)
  assert.match(wizardSource, /yarn install-skills --update/)
})

test('recursive shared emission produces a complete hash-owned standalone harness', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'om-shared-harness-'))
  mkdirSync(join(targetDir, 'src'), { recursive: true })
  writeFileSync(join(targetDir, 'src', 'modules.ts'), 'export const enabledModules = []\n')

  const config = { projectName: 'harness-fixture', targetDir }
  generateShared(config)
  finalizeHarnessManifest(config, [])

  for (const relativePath of [
    'AGENTS.md',
    '.ai/harness/cases.json',
    '.ai/harness/fixtures/seeds.json',
    '.ai/harness/release-result.schema.json',
    '.ai/harness/target-validation-result.schema.json',
    '.ai/lessons.md',
    '.ai/lessons/_template.md',
    '.ai/skills/om-evolve-harness/SKILL.md',
    '.ai/skills/om-share-this-session/SKILL.md',
    '.ai/skills/om-share-this-session/references/consent-and-review.md',
    '.ai/skills/om-share-this-session/scripts/prepare-share-bundle.mjs',
    'scripts/evaluate-agent-harness.mjs',
    'scripts/framework-context.mjs',
    'scripts/check-lessons.mjs',
    'scripts/install-skills.sh',
    'scripts/install-skills.mjs',
    'scripts/prepare-agent-harness-fixture.mjs',
    'scripts/run-agent-harness-release.mjs',
  ]) {
    assert.equal(existsSync(join(targetDir, relativePath)), true, `${relativePath} must be emitted recursively`)
  }
  if (process.platform !== 'win32') {
    assert.notEqual(statSync(join(targetDir, 'scripts', 'install-skills.sh')).mode & 0o111, 0)
  }

  const manifest = JSON.parse(readFileSync(join(targetDir, '.ai', 'harness', 'manifest.json'), 'utf8')) as {
    generator: string
    files: Array<{ path: string; sha256: string; source: string; userEditable: boolean }>
  }
  assert.match(manifest.generator, /^open-mercato-agentic@(?:unknown|\d+\.\d+\.\d+(?:[-+].+)?)$/)
  assert.ok(manifest.files.length > 80, 'the ownership manifest must cover the complete emitted tree')
  for (const entry of manifest.files) {
    const emittedPath = join(targetDir, entry.path)
    assert.equal(existsSync(emittedPath), true, `${entry.path} must exist`)
    assert.equal(createHash('sha256').update(readFileSync(emittedPath)).digest('hex'), entry.sha256)
  }
  assert.equal(
    manifest.files.find((entry) => entry.path === '.ai/skills/om-auto-create-pr/SKILL.md')?.source,
    'external-override',
  )
  assert.equal(
    manifest.files.find((entry) => entry.path === '.ai/skills/om-module-scaffold/SKILL.md')?.source,
    'local-skill',
  )
  assert.equal(manifest.files.find((entry) => entry.path === '.ai/lessons.md')?.userEditable, true)
  assert.equal(manifest.files.find((entry) => entry.path === '.ai/lessons/_template.md')?.userEditable, true)
  assert.equal(manifest.files.find((entry) => entry.path === 'scripts/check-lessons.mjs')?.userEditable, false)
  const lessonCheck = spawnSync(
    process.execPath,
    [join(targetDir, 'scripts', 'check-lessons.mjs'), '--root', targetDir],
    { encoding: 'utf8' },
  )
  assert.equal(lessonCheck.status, 0, `${lessonCheck.stdout}\n${lessonCheck.stderr}`)
  assert.equal(
    manifest.files.find((entry) => entry.path === '.ai/skills/om-share-this-session/SKILL.md')?.source,
    'local-skill',
  )
  assert.doesNotMatch(readFileSync(join(targetDir, 'AGENTS.md'), 'utf8'), /\{\{PROJECT_NAME\}\}/)
})

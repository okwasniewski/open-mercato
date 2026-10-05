import type { ChildProcess, StdioOptions } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import spawn from 'cross-spawn'
import { fetchWithTimeout, type FetchWithTimeoutInit } from '@open-mercato/shared/lib/http/fetchWithTimeout'
import { resolveEnvironment } from '../resolver'
import { resolveSpawnCommand } from '../spawn'
import { resolveDockerHostFromContext, runCommandAndCapture } from './runtime-utils'

type EphemeralRuntimeOptions = {
  verbose: boolean
  logPrefix: string
  forceRebuild?: boolean
  reuseExisting?: boolean
}

const TEST_EMAIL_CAPTURE_ACCESS_TOKEN =
  process.env.OM_TEST_EMAIL_CAPTURE_ACCESS_TOKEN ?? randomBytes(32).toString('hex')
const TEST_EMAIL_CAPTURE_CORRELATION_TOKEN =
  process.env.OM_TEST_EMAIL_CAPTURE_CORRELATION_TOKEN ?? randomBytes(32).toString('hex')

export type EphemeralEnvironmentHandle = {
  baseUrl: string
  port: number
  databaseUrl: string
  commandEnvironment: NodeJS.ProcessEnv
  ownedByCurrentProcess: boolean
  stop: () => Promise<void>
}

type EphemeralAppOptions = {
  verbose: boolean
  forceRebuild: boolean
  reuseExisting: boolean
}

export function shouldUseIsolatedPortForFreshEnvironment(options: {
  reuseExisting: boolean | undefined
  existingStateBeforeReuseAttempt: EphemeralEnvironmentState | null
}): boolean {
  return options.reuseExisting === false || options.existingStateBeforeReuseAttempt !== null
}

type EphemeralEnvironmentState = {
  status: 'running'
  baseUrl: string
  port: number
  databaseUrl: string
  queueBaseDir: string
  source: string
  startedAt: string
}

const DEFAULT_APP_READY_TIMEOUT_MS = 90_000
const APP_READY_INTERVAL_MS = 1_000
const DEFAULT_EPHEMERAL_APP_PORT = 5001
const EPHEMERAL_ENV_LOCK_TIMEOUT_MS = 5 * 60_000
const EPHEMERAL_ENV_LOCK_POLL_MS = 500
const DEFAULT_BUILD_CACHE_TTL_SECONDS = 600
const APP_READY_TIMEOUT_ENV_VAR = 'OM_INTEGRATION_APP_READY_TIMEOUT_SECONDS'
const BUILD_CACHE_TTL_ENV_VAR = 'OM_INTEGRATION_BUILD_CACHE_TTL_SECONDS'
const EPHEMERAL_POSTGRES_IMAGE_ENV_VAR = 'OM_INTEGRATION_POSTGRES_IMAGE'
// Dev/prod and the dev container run pgvector-enabled Postgres (see docker-compose*.yml,
// docker/postgres-init.sh, .devcontainer/docker-compose.yml). The ephemeral integration DB
// MUST match so that `CREATE EXTENSION vector` (packages/search/src/vector/drivers/pgvector)
// and any vector-search code path succeed. A plain `postgres:*` image lacks the extension
// files. Stay on pg16 to avoid behavioral drift in the existing suite; only add pgvector.
const DEFAULT_EPHEMERAL_POSTGRES_IMAGE = 'pgvector/pgvector:pg16'
// Eagerly create the extensions the platform relies on so they are guaranteed present in the
// fresh database, not merely available in the image. The ephemeral superuser can run these.
// Mirrors docker/postgres-init.sh (default DB + template1 so any future DB inherits them).
const EPHEMERAL_POSTGRES_INIT_SQL = `CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\\connect template1
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
`

export function resolveEphemeralPostgresImage(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[EPHEMERAL_POSTGRES_IMAGE_ENV_VAR]?.trim()
  return override && override.length > 0 ? override : DEFAULT_EPHEMERAL_POSTGRES_IMAGE
}

export function ephemeralPostgresInitSql(): string {
  return EPHEMERAL_POSTGRES_INIT_SQL
}
const env = resolveEnvironment()
const projectRootDirectory = env.rootDir
const appDirectory = env.appDir
const corePackageRootDirectory = env.packageRoot('@open-mercato/core')
const uiPackageRootDirectory = env.packageRoot('@open-mercato/ui')
const EPHEMERAL_RUNTIME_LOCK_PATH = path.join(projectRootDirectory, '.ai', 'qa', 'ephemeral-runtime.lock')

function resolveFirstExistingPath(...candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function collectExistingPaths(candidates: Array<string | null | undefined>): string[] {
  const collected = new Set<string>()
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      collected.add(candidate)
    }
  }
  return Array.from(collected)
}

function isLikelyNextAppDirectory(candidate: string): boolean {
  if (!existsSync(path.join(candidate, 'package.json'))) {
    return false
  }
  return resolveFirstExistingPath(
    path.join(candidate, 'next.config.ts'),
    path.join(candidate, 'next.config.js'),
    path.join(candidate, 'next.config.mjs'),
    path.join(candidate, 'src', 'modules.ts'),
  ) !== null
}

function resolveDefaultPrivateAttachmentsAppDirectory(): string {
  const candidates = [
    appDirectory,
    path.join(projectRootDirectory, 'apps', 'mercato'),
    path.join(projectRootDirectory, 'apps', 'app'),
  ]
  for (const candidate of candidates) {
    if (isLikelyNextAppDirectory(candidate)) {
      return candidate
    }
  }
  return appDirectory
}

function readPackageScripts(packageRoot: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return raw.scripts ?? {}
  } catch {
    return {}
  }
}

const projectScripts = readPackageScripts(projectRootDirectory)
const appNextConfigPath = resolveFirstExistingPath(
  path.join(appDirectory, 'next.config.ts'),
  path.join(appDirectory, 'next.config.js'),
  path.join(appDirectory, 'next.config.mjs'),
)
const APP_MODULES_CHECKSUM_PATH = path.join(appDirectory, '.mercato', 'generated', 'modules.generated.checksum')
const PROJECT_SUPPORTS_PACKAGE_BUILDS = typeof projectScripts['build:packages'] === 'string'
const EPHEMERAL_ENV_FILE_PATH = path.join(projectRootDirectory, '.ai', 'qa', 'ephemeral-env.json')
const EPHEMERAL_ENV_LOCK_PATH = path.join(projectRootDirectory, '.ai', 'qa', 'ephemeral-env.lock')
const LEGACY_EPHEMERAL_ENV_FILE_PATH = path.join(projectRootDirectory, '.ai', 'qa', 'ephemeral-env.md')
const EPHEMERAL_BUILD_CACHE_STATE_PATH = path.join(projectRootDirectory, '.ai', 'qa', 'ephemeral-build-cache.json')
const EPHEMERAL_CACHE_DB_PATH = path.join(projectRootDirectory, '.ai', 'qa', 'ephemeral-cache.sqlite')
const EPHEMERAL_EMAIL_CAPTURE_PATH = path.join(projectRootDirectory, '.ai', 'qa', 'email-capture.jsonl')
const EPHEMERAL_QUEUE_BASE_DIR = path.join(appDirectory, '.mercato', 'queue')
// The Communications Hub keeps its own tenant-scoped capture, in runtime state rather than in the
// repo: its record shape differs from the unscoped `shared/lib/email/send` capture above, and the
// repo ships a committed fixture copy of that one. One file for both would make each mechanism
// read the other's records.
const EPHEMERAL_SYSTEM_EMAIL_CAPTURE_PATH = path.join(appDirectory, '.mercato', 'test-email-capture.jsonl')
const PRIVATE_ATTACHMENTS_PARTITION_ENV_KEY = 'ATTACHMENTS_PARTITION_PRIVATE_ATTACHMENTS_ROOT'
const EPHEMERAL_PRIVATE_ATTACHMENTS_ROOT = path.join(
  resolveDefaultPrivateAttachmentsAppDirectory(),
  'storage',
  'attachments',
  'privateAttachments',
)
const NEXT_BUILD_OUTPUT_DIRECTORIES = [
  path.join(appDirectory, '.mercato', 'next'),
  path.join(appDirectory, '.next'),
]
const APP_BUILD_ARTIFACTS = collectExistingPaths([
  path.join(appDirectory, '.mercato', 'next', 'BUILD_ID'),
  path.join(appDirectory, '.next', 'BUILD_ID'),
  path.join(appDirectory, '.mercato', 'generated', 'modules.generated.ts'),
  path.join(corePackageRootDirectory, 'dist', 'index.js'),
  path.join(uiPackageRootDirectory, 'dist', 'index.js'),
])
const APP_BUILD_INPUT_PATHS = collectExistingPaths([
  path.join(appDirectory, 'src'),
  path.join(appDirectory, 'package.json'),
  appNextConfigPath,
  path.join(appDirectory, 'tsconfig.json'),
  resolveFirstExistingPath(path.join(corePackageRootDirectory, 'src'), path.join(corePackageRootDirectory, 'dist')),
  path.join(corePackageRootDirectory, 'package.json'),
  path.join(corePackageRootDirectory, 'tsconfig.json'),
  resolveFirstExistingPath(path.join(uiPackageRootDirectory, 'src'), path.join(uiPackageRootDirectory, 'dist')),
  path.join(uiPackageRootDirectory, 'package.json'),
  path.join(uiPackageRootDirectory, 'tsconfig.json'),
  path.join(projectRootDirectory, 'package.json'),
  path.join(projectRootDirectory, 'tsconfig.base.json'),
  path.join(projectRootDirectory, 'yarn.lock'),
])
const BACKEND_BROWSER_AUTH_REDIRECT_LIMIT = 6
const BUILD_CACHE_STATE_VERSION = 2
const BUILD_CACHE_ENV_KEYS = [
  'NODE_ENV',
  'OM_ENABLE_ENTERPRISE_MODULES',
  'OM_ENABLE_ENTERPRISE_MODULES_SSO',
  'OM_ENABLE_ENTERPRISE_MODULES_SECURITY',
] as const
const IGNORED_EPHEMERAL_BUILD_CACHE_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  '.turbo',
  '.yarn',
  '.cache',
  'tmp',
  'temp',
  'coverage',
  '.git',
  '.ai',
])

type BuildCacheState = {
  version: number
  builtAt: number
  sourceFingerprint: string
  environmentFingerprint: string
  artifactPaths: string[]
  projectRoot: string
}

type BuildCacheOptions = {
  artifactPaths?: string[]
  inputPaths?: string[]
  cacheStatePath?: string
  projectRoot?: string
  precomputedSourceFingerprint?: string
  environmentFingerprint?: string
}

type LoginPageProbeResult = {
  status: number | null
  healthy: boolean
  detail: string
}

type BackendLoginProbeResult = {
  status: number | null
  healthy: boolean
  detail: string
}

type AuthenticatedApiProbeResult = {
  loginStatus: number | null
  apiStatus: number | null
  healthy: boolean
  detail: string
}

type BackendBrowserAuthProbeResult = {
  loginStatus: number | null
  backendStatus: number | null
  healthy: boolean
  detail: string
}

type ApplicationReadinessProbeResult = {
  ready: boolean
  frontend: LoginPageProbeResult
  backend: BackendLoginProbeResult
  authenticated: AuthenticatedApiProbeResult
  backendBrowserAuth: BackendBrowserAuthProbeResult
}

type TimedStepOptions = {
  expectedSeconds: number
  updateIntervalSeconds?: number
}

function resolveYarnBinary(): string {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn'
}

function buildEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
  }
}

function buildEnvironmentFingerprint(environment: NodeJS.ProcessEnv): string {
  const publicKeys = Object.keys(environment)
    .filter((key) => key.startsWith('NEXT_PUBLIC_'))
    .sort((left, right) => left.localeCompare(right))
  const keys = Array.from(new Set([...BUILD_CACHE_ENV_KEYS, ...publicKeys]))
  const fingerprintParts = keys.map((key) => `${key}=${environment[key] ?? ''}`)
  return createHash('sha256').update(fingerprintParts.join('\n'), 'utf8').digest('hex')
}

async function resetNextBuildOutputDirectories(logPrefix: string): Promise<void> {
  for (const outputDirectory of NEXT_BUILD_OUTPUT_DIRECTORIES) {
    if (!existsSync(outputDirectory)) {
      continue
    }
    await rm(outputDirectory, { recursive: true, force: true })
    console.log(`[${logPrefix}] Reset Next build output directory at ${outputDirectory}.`)
  }
}

function runYarnCommand(
  args: string[],
  environment: NodeJS.ProcessEnv,
  opts: { silent?: boolean } = {},
  cwd: string = projectRootDirectory,
): Promise<void> {
  return runYarnRawCommand(['run', ...args], environment, opts, cwd)
}

async function runTimedStep<T>(
  logPrefix: string,
  label: string,
  options: TimedStepOptions,
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  const intervalMs = Math.max(1, options.updateIntervalSeconds ?? 2) * 1000
  const timer = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000))
    const remainingSeconds = Math.max(0, options.expectedSeconds - elapsedSeconds)
    console.log(`[${logPrefix}] ${label}... ${elapsedSeconds}s elapsed, ~${remainingSeconds}s left`)
  }, intervalMs)

  try {
    const result = await task()
    const durationSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000))
    console.log(`[${logPrefix}] ${label} completed in ${durationSeconds}s.`)
    return result
  } finally {
    clearInterval(timer)
  }
}

function runYarnRawCommand(
  commandArgs: string[],
  environment: NodeJS.ProcessEnv,
  opts: { silent?: boolean } = {},
  cwd: string = projectRootDirectory,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const outputMode: StdioOptions = opts.silent ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    const resolvedSpawn = resolveSpawnCommand(resolveYarnBinary(), commandArgs)
    const command: ChildProcess = spawn(resolvedSpawn.command, resolvedSpawn.args, {
      cwd,
      env: environment,
      stdio: outputMode,
      ...resolvedSpawn.spawnOptions,
    })
    let bufferedOutput = ''
    if (opts.silent) {
      command.stdout?.on('data', (chunk: Buffer | string) => {
        bufferedOutput += chunk.toString()
      })
      command.stderr?.on('data', (chunk: Buffer | string) => {
        bufferedOutput += chunk.toString()
      })
    }
    command.on('error', reject)
    command.on('exit', (code: number | null) => {
      if (code === 0) {
        resolve()
        return
      }
      const extra = opts.silent && bufferedOutput.trim().length > 0
        ? `\nLast output:\n${bufferedOutput.trim().split('\n').slice(-20).join('\n')}`
        : ''
      reject(new Error(`Command failed: yarn ${commandArgs.join(' ')} (exit ${code ?? 'unknown'})${extra}`))
    })
  })
}

export type CapturedOutputProcess = ChildProcess & {
  readCapturedOutput?: () => string
}

export const CAPTURED_OUTPUT_MAX_LENGTH = 64 * 1024

export function createBoundedOutputBuffer(): { append: (chunk: Buffer | string) => void; read: () => string } {
  let buffered = ''
  return {
    append: (chunk: Buffer | string) => {
      buffered += chunk.toString()
      if (buffered.length > CAPTURED_OUTPUT_MAX_LENGTH) {
        buffered = `…(truncated)…${buffered.slice(-CAPTURED_OUTPUT_MAX_LENGTH)}`
      }
    },
    read: () => buffered,
  }
}

// Both streams are returned when both carry output: a single stderr deprecation notice must not
// hide the stdout tail that usually holds the real startup failure. The 20-line tail in
// `exitError()` does the trimming.
export function formatCapturedOutput(stderrText: string, stdoutText: string): string {
  if (stderrText && stdoutText) {
    return `--- stderr ---\n${stderrText}\n--- stdout ---\n${stdoutText}`
  }
  return stderrText || stdoutText
}

function startYarnRawCommand(
  commandArgs: string[],
  environment: NodeJS.ProcessEnv,
  opts: { silent?: boolean; detached?: boolean } = {},
  cwd: string = projectRootDirectory,
): CapturedOutputProcess {
  const outputMode: StdioOptions = opts.silent ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  const resolvedSpawn = resolveSpawnCommand(resolveYarnBinary(), commandArgs, { detached: opts.detached })
  const processHandle: CapturedOutputProcess = spawn(resolvedSpawn.command, resolvedSpawn.args, {
    cwd,
    env: environment,
    stdio: outputMode,
    ...resolvedSpawn.spawnOptions,
  })
  if (opts.silent) {
    const stdoutBuffer = createBoundedOutputBuffer()
    const stderrBuffer = createBoundedOutputBuffer()
    processHandle.stdout?.on('data', (chunk: Buffer | string) => stdoutBuffer.append(chunk))
    processHandle.stderr?.on('data', (chunk: Buffer | string) => stderrBuffer.append(chunk))
    processHandle.readCapturedOutput = () =>
      formatCapturedOutput(stderrBuffer.read().trim(), stdoutBuffer.read().trim())
  }
  return processHandle
}

function startYarnCommand(
  args: string[],
  environment: NodeJS.ProcessEnv,
  opts: { silent?: boolean; detached?: boolean } = {},
  cwd: string = projectRootDirectory,
): CapturedOutputProcess {
  return startYarnRawCommand(['run', ...args], environment, opts, cwd)
}

async function assertContainerRuntimeAvailable(): Promise<void> {
  const dockerInfoResult = await runCommandAndCapture('docker', ['info'])
  if (dockerInfoResult.code === 0) {
    return
  }

  const normalizedError = dockerInfoResult.stderr.trim()
  let guidance = 'Container runtime is unavailable. Start Docker Desktop (or another Docker-compatible runtime) and retry.'
  if (dockerInfoResult.code === -1) {
    guidance = 'Docker CLI is not available in PATH. Install Docker Desktop (or Docker CLI + runtime), then retry.'
  } else if (normalizedError.includes('Cannot connect to the Docker daemon')) {
    guidance = 'Docker CLI is installed but daemon is not running. Start Docker Desktop, wait until it is healthy, then run `docker info` and retry.'
  }

  throw new Error(
    [
      'Unable to start ephemeral integration environment.',
      `Cause: ${normalizedError || 'docker info failed'}`,
      `What to do: ${guidance}`,
    ].join(' '),
  )
}

function assertNode24Runtime(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  if (major >= 24) {
    return
  }
  throw new Error(
    [
      'Unsupported Node.js runtime for ephemeral integration tests.',
      `Cause: Detected Node ${process.versions.node}, but this repository requires Node 24.x.`,
      'What to do: switch your shell to Node 24 (for example `nvm use 24`), reinstall dependencies (`yarn install`), then retry `yarn test:ephemeral:start`.',
    ].join(' '),
  )
}

function getProcessExitPromise(command: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    command.on('error', reject)
    command.on('exit', (code) => resolve(code))
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

// Each readiness probe fetch is bounded so a single stuck connection cannot consume the whole
// readiness budget; on timeout it surfaces as a probe failure and the next cycle retries.
const READINESS_PROBE_FETCH_TIMEOUT_MS = 15_000

function probeFetch(input: string, init: FetchWithTimeoutInit = {}): Promise<Response> {
  return fetchWithTimeout(input, { timeoutMs: READINESS_PROBE_FETCH_TIMEOUT_MS, ...init })
}

export function resolveBuildCacheTtlSeconds(logPrefix: string): number {
  const rawValue = process.env[BUILD_CACHE_TTL_ENV_VAR]
  if (!rawValue) {
    return DEFAULT_BUILD_CACHE_TTL_SECONDS
  }
  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[${logPrefix}] Invalid ${BUILD_CACHE_TTL_ENV_VAR} value "${rawValue}". Using default ${DEFAULT_BUILD_CACHE_TTL_SECONDS}s.`,
    )
    return DEFAULT_BUILD_CACHE_TTL_SECONDS
  }
  return parsed
}

export function resolveAppReadyTimeoutMs(logPrefix: string): number {
  const rawValue = process.env[APP_READY_TIMEOUT_ENV_VAR]
  if (!rawValue) {
    return DEFAULT_APP_READY_TIMEOUT_MS
  }
  const parsedSeconds = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsedSeconds) || parsedSeconds < 1) {
    console.warn(
      `[${logPrefix}] Invalid ${APP_READY_TIMEOUT_ENV_VAR} value "${rawValue}". Using default ${DEFAULT_APP_READY_TIMEOUT_MS / 1000}s.`,
    )
    return DEFAULT_APP_READY_TIMEOUT_MS
  }
  return parsedSeconds * 1000
}

function buildCacheDefaults(overrides: BuildCacheOptions = {}): {
  artifactPaths: string[]
  inputPaths: string[]
  cacheStatePath: string
  projectRoot: string
} {
  return {
    artifactPaths: overrides.artifactPaths ?? APP_BUILD_ARTIFACTS,
    inputPaths: overrides.inputPaths ?? APP_BUILD_INPUT_PATHS,
    cacheStatePath: overrides.cacheStatePath ?? EPHEMERAL_BUILD_CACHE_STATE_PATH,
    projectRoot: overrides.projectRoot ?? projectRootDirectory,
  }
}

function isIgnoredBuildCacheDirectory(entryName: string): boolean {
  return IGNORED_EPHEMERAL_BUILD_CACHE_DIRS.has(entryName) || entryName.startsWith('.')
}

async function getAllBuildInputFiles(inputPath: string, projectRoot: string): Promise<string[]> {
  const normalized = path.normalize(inputPath)
  const pathStats = await stat(normalized)
  if (pathStats.isFile()) {
    return [path.relative(projectRoot, normalized)]
  }
  if (!pathStats.isDirectory()) {
    return []
  }

  const entries = await readdir(normalized, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && isIgnoredBuildCacheDirectory(entry.name)) {
      continue
    }
    if (entry.isDirectory()) {
      const nested = await getAllBuildInputFiles(path.join(normalized, entry.name), projectRoot)
      files.push(...nested)
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    files.push(path.join(normalized, entry.name))
  }
  return files
}

async function buildSourceFingerprint(options: BuildCacheOptions = {}): Promise<string | null> {
  const { inputPaths, projectRoot } = buildCacheDefaults(options)
  const seenPaths = new Set<string>()
  const absoluteFiles: string[] = []

  for (const inputPath of inputPaths) {
    let collected: string[]
    try {
      collected = await getAllBuildInputFiles(inputPath, projectRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }

    for (const filePath of collected) {
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath)
      if (!seenPaths.has(resolvedPath)) {
        seenPaths.add(resolvedPath)
        absoluteFiles.push(resolvedPath)
      }
    }
  }

  if (absoluteFiles.length === 0) {
    return null
  }

  const fingerprintParts: string[] = []
  for (const filePath of absoluteFiles.sort((a, b) => a.localeCompare(b))) {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      continue
    }
    const relativePath = path.relative(projectRoot, filePath).split(path.sep).join('/')
    fingerprintParts.push(`${relativePath}:${fileStat.size}:${Math.floor(fileStat.mtimeMs)}`)
  }

  if (fingerprintParts.length === 0) {
    return null
  }

  return createHash('sha256').update(fingerprintParts.join('\n'), 'utf8').digest('hex')
}

async function hasBuildInputChangesSince(
  timestampMs: number,
  options: BuildCacheOptions = {},
): Promise<boolean> {
  const { inputPaths, projectRoot } = buildCacheDefaults(options)
  const seenPaths = new Set<string>()

  for (const inputPath of inputPaths) {
    let collected: string[]
    try {
      collected = await getAllBuildInputFiles(inputPath, projectRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }

    for (const filePath of collected) {
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath)
      if (seenPaths.has(resolvedPath)) {
        continue
      }
      seenPaths.add(resolvedPath)

      let fileStat: Awaited<ReturnType<typeof stat>>
      try {
        fileStat = await stat(resolvedPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return true
        }
        throw error
      }
      if (fileStat.isFile() && fileStat.mtimeMs > timestampMs) {
        return true
      }
    }
  }

  return false
}

async function readBuildCacheState(cacheStatePath: string): Promise<BuildCacheState | null> {
  let rawText: string
  try {
    rawText = await readFile(cacheStatePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }

  let parsed: unknown = null
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const maybeState = parsed as Partial<BuildCacheState>
  if (maybeState.version !== BUILD_CACHE_STATE_VERSION) {
    return null
  }
  if (typeof maybeState.builtAt !== 'number' || !Number.isFinite(maybeState.builtAt)) {
    return null
  }
  if (typeof maybeState.sourceFingerprint !== 'string' || maybeState.sourceFingerprint.length === 0) {
    return null
  }
  if (typeof maybeState.environmentFingerprint !== 'string' || maybeState.environmentFingerprint.length === 0) {
    return null
  }
  if (!Array.isArray(maybeState.artifactPaths) || maybeState.artifactPaths.length === 0) {
    return null
  }
  if (typeof maybeState.projectRoot !== 'string' || maybeState.projectRoot.length === 0) {
    return null
  }

  return {
    version: BUILD_CACHE_STATE_VERSION,
    builtAt: maybeState.builtAt,
    sourceFingerprint: maybeState.sourceFingerprint,
    environmentFingerprint: maybeState.environmentFingerprint,
    artifactPaths: maybeState.artifactPaths.filter((entry): entry is string => typeof entry === 'string'),
    projectRoot: maybeState.projectRoot,
  }
}

async function writeBuildCacheState(
  sourceFingerprint: string,
  options: BuildCacheOptions = {},
): Promise<void> {
  const defaults = buildCacheDefaults(options)
  const environmentFingerprint = options.environmentFingerprint ?? ''
  if (!environmentFingerprint) {
    throw new Error('Build cache state requires an environment fingerprint.')
  }
  await mkdir(path.dirname(defaults.cacheStatePath), { recursive: true })
  await writeFile(
    defaults.cacheStatePath,
    `${JSON.stringify(
      {
        version: BUILD_CACHE_STATE_VERSION,
        builtAt: Date.now(),
        sourceFingerprint,
        environmentFingerprint,
        artifactPaths: defaults.artifactPaths,
        projectRoot: defaults.projectRoot,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

async function isBuildArtifactMissing(filePath: string): Promise<boolean> {
  try {
    const artifactStats = await stat(filePath)
    return !artifactStats.isFile() || artifactStats.size <= 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true
    }
    throw error
  }
}

export async function shouldReuseBuildArtifacts(
  ttlSeconds: number,
  logPrefix: string,
  options: BuildCacheOptions = {},
): Promise<boolean> {
  if (ttlSeconds <= 0) {
    console.log(`[${logPrefix}] Build cache disabled: ${BUILD_CACHE_TTL_ENV_VAR} is set to ${ttlSeconds}.`)
    return false
  }

  const defaults = buildCacheDefaults(options)
  const currentSourceFingerprint = options.precomputedSourceFingerprint ?? (await buildSourceFingerprint(defaults))
  const currentEnvironmentFingerprint = options.environmentFingerprint ?? ''
  if (!currentSourceFingerprint) {
    console.log(
      `[${logPrefix}] Build cache disabled: unable to collect source fingerprints from tracked sources.`,
    )
    return false
  }
  if (!currentEnvironmentFingerprint) {
    console.log(`[${logPrefix}] Build cache disabled: missing environment fingerprint for cache validation.`)
    return false
  }

  const state = await readBuildCacheState(defaults.cacheStatePath)
  if (!state) {
    console.log(`[${logPrefix}] Build cache disabled: missing or invalid cache metadata (${defaults.cacheStatePath}).`)
    return false
  }

  if (state.projectRoot !== defaults.projectRoot) {
    console.log(`[${logPrefix}] Build cache disabled: project root changed since cache creation.`)
    return false
  }

  const buildAgeSeconds = Math.floor((Date.now() - state.builtAt) / 1000)
  if (buildAgeSeconds > ttlSeconds) {
    console.log(
      `[${logPrefix}] Build cache disabled: last build age ${buildAgeSeconds}s exceeds ${BUILD_CACHE_TTL_ENV_VAR}=${ttlSeconds}s.`,
    )
    return false
  }

  if (state.sourceFingerprint !== currentSourceFingerprint) {
    console.log(`[${logPrefix}] Build cache disabled: source files changed since last build.`)
    return false
  }
  if (state.environmentFingerprint !== currentEnvironmentFingerprint) {
    console.log(`[${logPrefix}] Build cache disabled: build-shaping environment changed since last build.`)
    return false
  }

  for (const artifactPath of defaults.artifactPaths) {
    if (await isBuildArtifactMissing(artifactPath)) {
      console.log(`[${logPrefix}] Build cache disabled: missing build artifact ${artifactPath}.`)
      return false
    }
  }

  console.log(
    `[${logPrefix}] Reusing existing build artifacts (last build age ${buildAgeSeconds}s, TTL ${ttlSeconds}s).`,
  )
  return true
}

export async function shouldRebuildBuildArtifacts(
  ttlSeconds: number,
  logPrefix: string,
  options: BuildCacheOptions = {},
): Promise<boolean> {
  return !(await shouldReuseBuildArtifacts(ttlSeconds, logPrefix, options))
}

async function getFreePort(): Promise<number> {
  const tryListen = (host: string): Promise<number | null> => new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', (error) => {
      const errorCode = (error as NodeJS.ErrnoException).code
      if (errorCode === 'EAFNOSUPPORT') {
        resolve(null)
        return
      }
      reject(error)
    })
    server.listen(0, host, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Unable to allocate free port'))
        return
      }
      const port = address.port
      server.close((closeError) => {
        if (closeError) {
          reject(closeError)
          return
        }
        resolve(port)
      })
    })
  })

  return (await tryListen('::')) ?? await tryListen('127.0.0.1') ?? Promise.reject(new Error('Unable to allocate free port'))
}

async function isPortAvailable(port: number): Promise<boolean> {
  const canBind = (host: string): Promise<boolean | null> => new Promise((resolve) => {
    const server = createServer()
    server.once('error', (error) => {
      const errorCode = (error as NodeJS.ErrnoException).code
      if (errorCode === 'EAFNOSUPPORT') {
        resolve(null)
        return
      }
      resolve(false)
    })
    server.listen(port, host, () => {
      server.close(() => {
        resolve(true)
      })
    })
  })

  const wildcardIpv6Availability = await canBind('::')
  if (wildcardIpv6Availability === false) {
    return false
  }

  const ipv4Availability = await canBind('127.0.0.1')
  if (ipv4Availability === false) {
    return false
  }

  return wildcardIpv6Availability === true || ipv4Availability === true
}

async function getPreferredPort(preferredPort: number): Promise<number> {
  if (await isPortAvailable(preferredPort)) {
    return preferredPort
  }
  const fallbackPort = await getFreePort()
  console.log(`[ephemeral] Port ${preferredPort} is busy, using fallback port ${fallbackPort}.`)
  return fallbackPort
}

export async function writeEphemeralEnvironmentState(input: {
  baseUrl: string
  port: number
  databaseUrl: string
  queueBaseDir: string
  logPrefix: string
}): Promise<void> {
  const content: EphemeralEnvironmentState = {
    status: 'running',
    baseUrl: input.baseUrl,
    port: input.port,
    databaseUrl: input.databaseUrl,
    queueBaseDir: input.queueBaseDir,
    source: input.logPrefix,
    startedAt: new Date().toISOString(),
  }
  await writeFile(EPHEMERAL_ENV_FILE_PATH, `${JSON.stringify(content, null, 2)}\n`, 'utf8')
}

export async function clearEphemeralEnvironmentState(): Promise<void> {
  await rm(EPHEMERAL_ENV_FILE_PATH, { force: true })
  await rm(LEGACY_EPHEMERAL_ENV_FILE_PATH, { force: true })
}

export async function readEphemeralEnvironmentState(): Promise<EphemeralEnvironmentState | null> {
  let sourceText = ''
  try {
    sourceText = await readFile(EPHEMERAL_ENV_FILE_PATH, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }

  let parsed: unknown = null
  try {
    parsed = JSON.parse(sourceText)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const record = parsed as Partial<EphemeralEnvironmentState>
  if (record.status !== 'running') {
    return null
  }
  if (typeof record.baseUrl !== 'string' || record.baseUrl.length === 0) {
    return null
  }
  if (typeof record.port !== 'number' || !Number.isFinite(record.port) || record.port < 1) {
    return null
  }
  if (typeof record.databaseUrl !== 'string' || record.databaseUrl.length === 0) {
    return null
  }
  if (typeof record.queueBaseDir !== 'string' || record.queueBaseDir.length === 0) {
    return null
  }
  if (typeof record.source !== 'string' || record.source.length === 0) {
    return null
  }
  if (typeof record.startedAt !== 'string' || record.startedAt.length === 0) {
    return null
  }

  return {
    status: 'running',
    baseUrl: record.baseUrl,
    port: record.port,
    databaseUrl: record.databaseUrl,
    queueBaseDir: record.queueBaseDir,
    source: record.source,
    startedAt: record.startedAt,
  }
}

function isLoginHtmlHealthy(html: string): boolean {
  return !/Application error: a client-side exception has occurred/i.test(html)
}

function isSuccessfulBrowserNavigationStatus(status: number): boolean {
  return status === 200 || (status >= 300 && status < 400)
}

async function probeLoginPage(baseUrl: string): Promise<LoginPageProbeResult> {
  try {
    const response = await probeFetch(`${baseUrl}/login`, {
      method: 'GET',
      redirect: 'manual',
    })
    if (!isSuccessfulBrowserNavigationStatus(response.status)) {
      return {
        status: response.status,
        healthy: false,
        detail: `GET /login returned ${response.status}`,
      }
    }
    if (response.status !== 200) {
      return {
        status: response.status,
        healthy: true,
        detail: `GET /login returned redirect ${response.status}`,
      }
    }
    const html = await response.text().catch(() => '')
    if (!isLoginHtmlHealthy(html)) {
      return {
        status: response.status,
        healthy: false,
        detail: 'GET /login returned client-side exception HTML',
      }
    }
    return {
      status: response.status,
      healthy: true,
      detail: 'GET /login returned healthy HTML',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: null,
      healthy: false,
      detail: `GET /login failed: ${message}`,
    }
  }
}

async function probeBackendLoginEndpoint(baseUrl: string): Promise<BackendLoginProbeResult> {
  try {
    const form = new URLSearchParams()
    form.set('email', 'integration-healthcheck@example.invalid')
    form.set('password', 'invalid-password')
    const response = await probeFetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })

    const healthy = response.status === 200 || response.status === 400 || response.status === 401 || response.status === 403
    return {
      status: response.status,
      healthy,
      detail: healthy
        ? `POST /api/auth/login returned ${response.status}`
        : `POST /api/auth/login returned unexpected ${response.status}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: null,
      healthy: false,
      detail: `POST /api/auth/login failed: ${message}`,
    }
  }
}

async function probeAuthenticatedApi(baseUrl: string): Promise<AuthenticatedApiProbeResult> {
  try {
    const form = new URLSearchParams()
    form.set('email', 'admin@acme.com')
    form.set('password', 'secret')
    const loginResponse = await probeFetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })

    const rawBody = await loginResponse.text().catch(() => '')
    let token: string | null = null
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody) as { token?: unknown }
        token = typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null
      } catch {
        token = null
      }
    }

    if (!loginResponse.ok || !token) {
      return {
        loginStatus: loginResponse.status,
        apiStatus: null,
        healthy: false,
        detail: loginResponse.ok
          ? 'POST /api/auth/login did not return an auth token'
          : `POST /api/auth/login returned ${loginResponse.status}`,
      }
    }

    const apiResponse = await probeFetch(`${baseUrl}/api/customers/people?pageSize=1`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    const healthy = apiResponse.status === 200
    return {
      loginStatus: loginResponse.status,
      apiStatus: apiResponse.status,
      healthy,
      detail: healthy
        ? 'Authenticated GET /api/customers/people returned 200'
        : `Authenticated GET /api/customers/people returned ${apiResponse.status}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      loginStatus: null,
      apiStatus: null,
      healthy: false,
      detail: `Authenticated readiness probe failed: ${message}`,
    }
  }
}

type HeadersWithSetCookie = Headers & {
  getSetCookie?: () => string[]
}

function splitSetCookieHeader(header: string): string[] {
  return header
    .split(/,(?=\s*[^;,\s=]+=)/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

function getSetCookieHeaders(headers: Headers | undefined): string[] {
  if (!headers) {
    return []
  }

  const setCookieGetter = (headers as HeadersWithSetCookie).getSetCookie
  if (typeof setCookieGetter === 'function') {
    return setCookieGetter.call(headers)
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  }

  const combined = headers.get('set-cookie')
  return combined ? splitSetCookieHeader(combined) : []
}

function parseSetCookiePair(header: string): { name: string; value: string } | null {
  const pair = header.split(';', 1)[0]?.trim()
  if (!pair) {
    return null
  }
  const equalsIndex = pair.indexOf('=')
  if (equalsIndex <= 0) {
    return null
  }
  const name = pair.slice(0, equalsIndex).trim()
  if (!name) {
    return null
  }
  return {
    name,
    value: pair.slice(equalsIndex + 1),
  }
}

function addSetCookieHeadersToJar(jar: Map<string, string>, headers: Headers | undefined): void {
  for (const setCookieHeader of getSetCookieHeaders(headers)) {
    const pair = parseSetCookiePair(setCookieHeader)
    if (pair) {
      jar.set(pair.name, pair.value)
    }
  }
}

function serializeCookieJar(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

function formatCookieNames(jar: Map<string, string>): string {
  const names = [...jar.keys()].sort((left, right) => left.localeCompare(right))
  return names.length > 0 ? names.join(', ') : 'none'
}

function toReadinessPath(url: URL): string {
  return url.pathname || '/'
}

function resolveReadinessRedirect(
  baseUrl: URL,
  currentUrl: URL,
  rawLocation: string | null,
): { url: URL; path: string } | { error: string } {
  const location = rawLocation?.trim()
  if (!location) {
    return { error: 'missing Location header' }
  }
  if (location.startsWith('//')) {
    return { error: 'protocol-relative redirect' }
  }

  let nextUrl: URL
  try {
    nextUrl = new URL(location, currentUrl)
  } catch {
    return { error: 'invalid Location header' }
  }

  if (nextUrl.origin !== baseUrl.origin) {
    return { error: 'cross-origin redirect' }
  }

  return {
    url: nextUrl,
    path: toReadinessPath(nextUrl),
  }
}

async function probeBackendBrowserAuth(baseUrl: string): Promise<BackendBrowserAuthProbeResult> {
  try {
    const base = new URL(baseUrl)
    const form = new URLSearchParams()
    form.set('email', 'admin@acme.com')
    form.set('password', 'secret')
    const loginResponse = await probeFetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })

    if (!loginResponse.ok) {
      return {
        loginStatus: loginResponse.status,
        backendStatus: null,
        healthy: false,
        detail: `Backend browser auth login returned ${loginResponse.status}`,
      }
    }

    const cookieJar = new Map<string, string>()
    addSetCookieHeadersToJar(cookieJar, loginResponse.headers)
    if (cookieJar.size === 0) {
      return {
        loginStatus: loginResponse.status,
        backendStatus: null,
        healthy: false,
        detail: 'Backend browser auth login returned no cookies',
      }
    }

    let currentUrl = new URL('/backend', base)
    let backendStatus: number | null = null
    const visitedPaths = new Set<string>()
    const trace: string[] = []

    for (let redirectCount = 0; redirectCount <= BACKEND_BROWSER_AUTH_REDIRECT_LIMIT; redirectCount += 1) {
      const currentPath = toReadinessPath(currentUrl)
      visitedPaths.add(currentPath)
      const response = await probeFetch(currentUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Cookie: serializeCookieJar(cookieJar),
        },
      })
      backendStatus = response.status
      addSetCookieHeadersToJar(cookieJar, response.headers)

      const location = response.headers?.get('location') ?? null
      const traceRedirect = location ? resolveReadinessRedirect(base, currentUrl, location) : null
      const statusAndLocation = traceRedirect && !('error' in traceRedirect)
        ? `${currentPath} ${response.status} -> ${traceRedirect.path}`
        : `${currentPath} ${response.status}${location ? ' -> [unsafe]' : ''}`
      trace.push(statusAndLocation)

      if (response.status === 200 && currentPath === '/backend') {
        return {
          loginStatus: loginResponse.status,
          backendStatus,
          healthy: true,
          detail: `Cookie-backed GET /backend returned 200 (cookies: ${formatCookieNames(cookieJar)})`,
        }
      }

      if (response.status < 300 || response.status >= 400) {
        return {
          loginStatus: loginResponse.status,
          backendStatus,
          healthy: false,
          detail: `Cookie-backed GET ${currentPath} returned ${response.status} (cookies: ${formatCookieNames(cookieJar)}; trace: ${trace.join(' | ')})`,
        }
      }

      const redirect = traceRedirect ?? resolveReadinessRedirect(base, currentUrl, location)
      if ('error' in redirect) {
        return {
          loginStatus: loginResponse.status,
          backendStatus,
          healthy: false,
          detail: `Backend browser auth probe followed unsafe redirect: ${redirect.error} (cookies: ${formatCookieNames(cookieJar)}; trace: ${trace.join(' | ')})`,
        }
      }

      if (visitedPaths.has(redirect.path)) {
        trace.push(redirect.path)
        return {
          loginStatus: loginResponse.status,
          backendStatus,
          healthy: false,
          detail: `Backend browser auth probe detected redirect loop: ${trace.join(' | ')} (cookies: ${formatCookieNames(cookieJar)})`,
        }
      }

      currentUrl = redirect.url
    }

    return {
      loginStatus: loginResponse.status,
      backendStatus,
      healthy: false,
      detail: `Backend browser auth probe exceeded ${BACKEND_BROWSER_AUTH_REDIRECT_LIMIT} redirects (cookies: ${formatCookieNames(cookieJar)}; trace: ${trace.join(' | ')})`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      loginStatus: null,
      backendStatus: null,
      healthy: false,
      detail: `Backend browser auth probe failed: ${message}`,
    }
  }
}

async function probeApplicationReadiness(baseUrl: string): Promise<ApplicationReadinessProbeResult> {
  const [frontend, backend, authenticated, backendBrowserAuth] = await Promise.all([
    probeLoginPage(baseUrl),
    probeBackendLoginEndpoint(baseUrl),
    probeAuthenticatedApi(baseUrl),
    probeBackendBrowserAuth(baseUrl),
  ])

  return {
    ready: frontend.healthy && backend.healthy && authenticated.healthy && backendBrowserAuth.healthy,
    frontend,
    backend,
    authenticated,
    backendBrowserAuth,
  }
}

async function acquireEphemeralEnvironmentLock(logPrefix: string): Promise<{ release: () => Promise<void> }> {
  await mkdir(path.dirname(EPHEMERAL_ENV_LOCK_PATH), { recursive: true })
  const deadlineTimestamp = Date.now() + EPHEMERAL_ENV_LOCK_TIMEOUT_MS
  let waitingLogged = false

  while (true) {
    try {
      await mkdir(EPHEMERAL_ENV_LOCK_PATH)
      const lockOwnerPath = path.join(EPHEMERAL_ENV_LOCK_PATH, 'owner.json')
      await writeFile(
        lockOwnerPath,
        `${JSON.stringify({ pid: process.pid, source: logPrefix, acquiredAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      )
      return {
        release: async () => {
          await rm(EPHEMERAL_ENV_LOCK_PATH, { recursive: true, force: true })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      if (await clearStaleEphemeralEnvironmentLock(logPrefix)) {
        continue
      }
    }

    const remainingMilliseconds = deadlineTimestamp - Date.now()
    if (remainingMilliseconds <= 0) {
      throw new Error(
        `Timed out after ${EPHEMERAL_ENV_LOCK_TIMEOUT_MS / 1000}s waiting for ephemeral environment setup lock at ${EPHEMERAL_ENV_LOCK_PATH}.`,
      )
    }

    if (!waitingLogged) {
      console.log(`[${logPrefix}] Waiting for another process to finish preparing the ephemeral environment...`)
      waitingLogged = true
    }
    await delay(Math.min(EPHEMERAL_ENV_LOCK_POLL_MS, remainingMilliseconds))
  }
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export type ProcessTreeKillDependencies = {
  platform?: NodeJS.Platform
  killPosixProcessGroup?: (pid: number, signal: NodeJS.Signals) => void
  killWindowsProcessTree?: (pid: number, options: { forced: boolean }) => void
  gracePeriodMs?: number
}

function defaultKillPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal)
}

// `/f` is added only on escalation so the Windows path mirrors the POSIX SIGTERM → grace → SIGKILL
// sequence: the first attempt lets the tree shut down cleanly, the second forces it.
function defaultKillWindowsProcessTree(pid: number, options: { forced: boolean }): void {
  spawnSync('taskkill', ['/pid', String(pid), '/t', ...(options.forced ? ['/f'] : [])])
}

export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  dependencies: ProcessTreeKillDependencies = {},
): void {
  const platform = dependencies.platform ?? process.platform
  if (platform === 'win32') {
    const killWindowsProcessTree = dependencies.killWindowsProcessTree ?? defaultKillWindowsProcessTree
    killWindowsProcessTree(pid, { forced: signal === 'SIGKILL' })
    return
  }
  const killPosixProcessGroup = dependencies.killPosixProcessGroup ?? defaultKillPosixProcessGroup
  killPosixProcessGroup(pid, signal)
}

const PROCESS_TREE_KILL_GRACE_PERIOD_MS = 3_000

function killProcessTreeIfRunning(
  pid: number,
  signal: NodeJS.Signals,
  dependencies: ProcessTreeKillDependencies,
): void {
  try {
    killProcessTree(pid, signal, dependencies)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error
    }
  }
}

// `getProcessExitPromise` only observes *future* events, so a process that already exited would
// never settle it and the caller would stall for the whole grace period. This waiter detaches both
// listeners and clears the timer whichever way it settles, so nothing is left pending and a late
// `'error'` cannot surface as an unhandled rejection.
function waitForProcessExitWithin(childProcess: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (exited: boolean) => {
      clearTimeout(gracePeriodTimer)
      childProcess.off('exit', onExit)
      childProcess.off('error', onError)
      resolve(exited)
    }
    const onExit = () => settle(true)
    const onError = () => settle(false)
    const gracePeriodTimer = setTimeout(() => settle(false), timeoutMs)
    childProcess.on('exit', onExit)
    childProcess.on('error', onError)
  })
}

// A `ChildProcess` reports `null` on both fields while it is alive, so a non-null value means the
// exit has already happened and its `'exit'` event will never fire again.
function hasProcessAlreadyExited(childProcess: ChildProcess): boolean {
  return (childProcess.exitCode ?? null) !== null || (childProcess.signalCode ?? null) !== null
}

export async function terminateProcessTree(
  childProcess: CapturedOutputProcess,
  dependencies: ProcessTreeKillDependencies = {},
): Promise<void> {
  const pid = childProcess.pid
  if (!pid) return
  // A reaped leader answers only "waiting for its `'exit'` event can never settle" — without this the
  // crash path would stall the whole teardown for the grace period waiting for an event that already
  // fired. It does *not* mean the process group is empty: on the readiness-failure path the `yarn`
  // wrapper exits non-zero while the `mercato start`/Next/worker descendants it spawned stay in its
  // group, so the group still has to be signalled or #5333's orphan survives verbatim. POSIX keeps
  // the group id reserved while any member holds it, so signalling it after the leader is reaped is
  // both safe and effective. Skip the wait, never the signal — and go straight to SIGKILL, since
  // there is no leader left to coordinate a graceful shutdown or to report the exit we would await.
  if (hasProcessAlreadyExited(childProcess)) {
    killProcessTreeIfRunning(pid, 'SIGKILL', dependencies)
    return
  }

  killProcessTreeIfRunning(pid, 'SIGTERM', dependencies)

  const gracePeriodMs = dependencies.gracePeriodMs ?? PROCESS_TREE_KILL_GRACE_PERIOD_MS
  const exitedBeforeGracePeriod = await waitForProcessExitWithin(childProcess, gracePeriodMs)

  if (!exitedBeforeGracePeriod && isProcessRunning(pid)) {
    killProcessTreeIfRunning(pid, 'SIGKILL', dependencies)
  }
}

const EPHEMERAL_SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

export type ShutdownProcessRef = Pick<NodeJS.Process, 'once' | 'off' | 'removeAllListeners' | 'kill' | 'pid'>

export type EphemeralShutdownHandlers = { dispose: () => void }

// The application is spawned `detached: true`, which puts its whole tree in a new session. A
// terminal Ctrl+C only reaches the foreground process group of the controlling terminal, so the
// tree never sees the signal and would outlive the run holding `server-start.lock` — exactly the
// orphan this harness exists to prevent. Node also skips `'exit'` listeners when it dies from a
// signal, so the crash sweep cannot cover this path either. The runner therefore forwards the
// interrupt itself: stop the environment, then re-raise the signal so the process still exits with
// the conventional 130/143 instead of a synthetic success.
export function registerEphemeralShutdownHandlers(options: {
  stop: () => Promise<void>
  killApplicationTree: () => void
  onSignal?: (signal: NodeJS.Signals) => void
  processRef?: ShutdownProcessRef
}): EphemeralShutdownHandlers {
  const processRef = options.processRef ?? process
  const onProcessExit = () => options.killApplicationTree()
  const signalHandlers = new Map<NodeJS.Signals, () => void>()

  // Registered per `startEphemeralEnvironment()` call, and the environment is restarted on retry,
  // so the handlers must come back off in `stop()` or a retried run stacks dead closures until it
  // trips MaxListenersExceededWarning.
  const dispose = () => {
    processRef.off('exit', onProcessExit)
    for (const [signal, handler] of signalHandlers) {
      processRef.off(signal, handler)
    }
    signalHandlers.clear()
  }

  for (const signal of EPHEMERAL_SHUTDOWN_SIGNALS) {
    const handler = () => {
      void (async () => {
        options.onSignal?.(signal)
        try {
          await options.stop()
        } catch (error) {
          // A teardown failure must not become an unhandled rejection, and must not swallow the
          // signal: report it and still re-raise so the runner exits the way the shell expects.
          console.error(`Failed to stop the ephemeral environment on ${signal}:`, error)
        } finally {
          dispose()
          // Load-bearing, not cleanup: `dispose()` already detached this module's `once` handler, so
          // the only listeners left belong to somebody else (testcontainers, the e2e runner, a host CLI).
          // Any survivor would swallow the re-raised signal and turn the interrupt back into the
          // synthetic success this whole path exists to avoid, so they come off before the re-raise.
          processRef.removeAllListeners(signal)
          processRef.kill(processRef.pid as number, signal)
        }
      })()
    }
    signalHandlers.set(signal, handler)
    processRef.once(signal, handler)
  }

  processRef.once('exit', onProcessExit)
  return { dispose }
}

async function getPathAgeMilliseconds(targetPath: string): Promise<number | null> {
  try {
    const stats = await stat(targetPath)
    return Date.now() - stats.mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function clearStaleEphemeralEnvironmentLock(logPrefix: string): Promise<boolean> {
  const lockOwnerPath = path.join(EPHEMERAL_ENV_LOCK_PATH, 'owner.json')
  let ownerPid: number | null = null

  let ownerReadFailed = false
  try {
    const ownerSource = await readFile(lockOwnerPath, 'utf8')
    const parsed = JSON.parse(ownerSource) as { pid?: unknown }
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      ownerPid = parsed.pid
    }
  } catch {
    ownerReadFailed = true
  }

  if (ownerPid === null) {
    const lockAge = await getPathAgeMilliseconds(EPHEMERAL_ENV_LOCK_PATH)
    if (lockAge === null) {
      return false
    }
    if (ownerReadFailed && lockAge > EPHEMERAL_ENV_LOCK_TIMEOUT_MS) {
      await rm(EPHEMERAL_ENV_LOCK_PATH, { recursive: true, force: true })
      console.log(`[${logPrefix}] Removed stale ephemeral environment lock with invalid owner metadata.`)
      return true
    }
    return false
  }

  if (isProcessRunning(ownerPid)) {
    return false
  }

  await rm(EPHEMERAL_ENV_LOCK_PATH, { recursive: true, force: true })
  console.log(`[${logPrefix}] Removed stale ephemeral environment lock from exited process ${ownerPid}.`)
  return true
}

type EphemeralRuntimeLockOptions = {
  lockPath?: string
  isProcessRunning?: (processId: number) => boolean
}

type EphemeralRuntimeLockOwner = {
  pid: number
  source?: string
  acquiredAt?: string
}

async function readEphemeralRuntimeLockOwner(lockPath: string): Promise<EphemeralRuntimeLockOwner | null> {
  const ownerPath = path.join(lockPath, 'owner.json')
  let ownerSource = ''
  try {
    ownerSource = await readFile(ownerPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }

  let parsed: unknown = null
  try {
    parsed = JSON.parse(ownerSource)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const record = parsed as Partial<EphemeralRuntimeLockOwner>
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid < 1) {
    return null
  }

  return {
    pid: record.pid,
    source: typeof record.source === 'string' ? record.source : undefined,
    acquiredAt: typeof record.acquiredAt === 'string' ? record.acquiredAt : undefined,
  }
}

async function clearStaleEphemeralRuntimeLock(
  logPrefix: string,
  options: Required<EphemeralRuntimeLockOptions>,
): Promise<boolean> {
  const owner = await readEphemeralRuntimeLockOwner(options.lockPath)
  const lockAge = await getPathAgeMilliseconds(options.lockPath)
  if (!owner) {
    if (lockAge !== null && lockAge > EPHEMERAL_ENV_LOCK_TIMEOUT_MS) {
      await rm(options.lockPath, { recursive: true, force: true })
      console.log(`[${logPrefix}] Removed stale ephemeral runtime lock with invalid owner metadata.`)
      return true
    }
    return false
  }

  if (options.isProcessRunning(owner.pid)) {
    return false
  }

  await rm(options.lockPath, { recursive: true, force: true })
  console.log(`[${logPrefix}] Removed stale ephemeral runtime lock from exited process ${owner.pid}.`)
  return true
}

export async function acquireEphemeralRuntimeLock(
  logPrefix: string,
  options: EphemeralRuntimeLockOptions = {},
): Promise<{ release: () => Promise<void> }> {
  const resolvedOptions: Required<EphemeralRuntimeLockOptions> = {
    lockPath: options.lockPath ?? EPHEMERAL_RUNTIME_LOCK_PATH,
    isProcessRunning: options.isProcessRunning ?? isProcessRunning,
  }

  await mkdir(path.dirname(resolvedOptions.lockPath), { recursive: true })

  try {
    await mkdir(resolvedOptions.lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }

    if (await clearStaleEphemeralRuntimeLock(logPrefix, resolvedOptions)) {
      return acquireEphemeralRuntimeLock(logPrefix, resolvedOptions)
    }

    const owner = await readEphemeralRuntimeLockOwner(resolvedOptions.lockPath)
    const ownerSource = owner?.source ? ` started by "${owner.source}"` : ''
    const ownerPid = owner?.pid ? ` (pid ${owner.pid})` : ''
    throw new Error(
      `[${logPrefix}] Another ephemeral environment is already active${ownerSource}${ownerPid}. Reuse the running environment or stop it before starting a fresh ephemeral run, because a second build/generate pipeline would overwrite shared workspace artifacts.`,
    )
  }

  const ownerPath = path.join(resolvedOptions.lockPath, 'owner.json')
  await writeFile(
    ownerPath,
    `${JSON.stringify({ pid: process.pid, source: logPrefix, acquiredAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )

  return {
    release: async () => {
      await rm(resolvedOptions.lockPath, { recursive: true, force: true })
    },
  }
}

function buildReusableEnvironment(
  baseUrl: string,
  databaseUrl: string,
  queueBaseDir: string,
): NodeJS.ProcessEnv {
  const enterpriseModulesFlag = process.env.OM_ENABLE_ENTERPRISE_MODULES ?? 'false'
  const privateAttachmentsRoot = resolvePrivateAttachmentsRootForQueueBaseDir(queueBaseDir)
  return buildEnvironment({
    DATABASE_URL: databaseUrl,
    BASE_URL: baseUrl,
    APP_URL: baseUrl,
    NEXT_PUBLIC_APP_URL: baseUrl,
    PLATFORM_PORTAL_BASE_URL: baseUrl,
    NODE_ENV: 'production',
    // Share the app server's cache backend with the test process and the
    // queue-drain runners it spawns (drainIntegrationQueue children inherit
    // this env). Without it those processes default to the in-memory cache
    // strategy, their invalidateCrudCache calls never reach the app's sqlite
    // cache, and any test whose drain-runner wins the job race then polls a
    // stale CRUD response until the TTL (TC-CRM-028/079, TC-SX-001).
    CACHE_STRATEGY: 'sqlite',
    CACHE_SQLITE_PATH: EPHEMERAL_CACHE_DB_PATH,
    JWT_SECRET: process.env.JWT_SECRET ?? 'om-ephemeral-integration-jwt-secret',
    OM_SECURITY_MFA_SETUP_SECRET: process.env.OM_SECURITY_MFA_SETUP_SECRET ?? 'om-ephemeral-integration-mfa-setup-secret',
    // Integration probe + tests expect `admin@acme.com / secret` and
    // `employee@acme.com / secret`. NODE_ENV=production routes derived-user
    // password resolution through the random-fallback branch unless these
    // env vars are explicitly set; without the override every fresh
    // ephemeral run would mint random passwords and the login probe would
    // never converge. This is the documented production contract: set
    // OM_INIT_*_PASSWORD to fix the seeded credential.
    OM_INIT_ADMIN_PASSWORD: process.env.OM_INIT_ADMIN_PASSWORD ?? 'secret',
    OM_INIT_EMPLOYEE_PASSWORD: process.env.OM_INIT_EMPLOYEE_PASSWORD ?? 'secret',
    OM_INTEGRATION_TEST: 'true',
    OM_ENABLE_ENTERPRISE_MODULES: enterpriseModulesFlag,
    OM_ENABLE_ENTERPRISE_MODULES_SSO: process.env.OM_ENABLE_ENTERPRISE_MODULES_SSO ?? enterpriseModulesFlag,
    OM_ENABLE_ENTERPRISE_MODULES_SECURITY: process.env.OM_ENABLE_ENTERPRISE_MODULES_SECURITY ?? enterpriseModulesFlag,
    OM_TEST_MODE: '1',
    OM_TEST_EMAIL_CAPTURE_PATH: process.env.OM_TEST_EMAIL_CAPTURE_PATH ?? EPHEMERAL_EMAIL_CAPTURE_PATH,
    OM_TEST_AUTH_RATE_LIMIT_MODE: 'opt-in',
    // Browser RUM is an environment-wide env switch, so without a per-request opt-in a spec
    // could only cover the enabled path by booting the OTel web SDK on every page of every
    // other spec. Same shape as the auth rate-limit escape hatch above: inert unless a request
    // also carries the `om_test_browser_telemetry=on` cookie, which only TC-TELEMETRY-002 sets.
    OM_TEST_BROWSER_TELEMETRY_MODE: 'opt-in',
    OM_DISABLE_EMAIL_DELIVERY: '0',
    OM_ENABLE_TEST_CHANNEL_SEEDING: 'true',
    OM_ENABLE_TEST_EMAIL_CAPTURE_DELIVERY: 'true',
    OM_TEST_SYSTEM_EMAIL_CAPTURE_PATH: EPHEMERAL_SYSTEM_EMAIL_CAPTURE_PATH,
    OM_TEST_EMAIL_CAPTURE_ACCESS_TOKEN: TEST_EMAIL_CAPTURE_ACCESS_TOKEN,
    OM_TEST_EMAIL_CAPTURE_CORRELATION_TOKEN: TEST_EMAIL_CAPTURE_CORRELATION_TOKEN,
    SYSTEM_EMAIL_PROVIDER: '__test_seed__',
    EMAIL_FROM: process.env.EMAIL_FROM ?? 'system@test-seed.local',
    NOTIFICATIONS_EMAIL_FROM: process.env.NOTIFICATIONS_EMAIL_FROM ?? 'notifications@test-seed.local',
    ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? 'admin@test-seed.local',
    // Register the test-only `push_stub` channel adapter in the reused test
    // process (and any drain/worker child it spawns) so push integration specs can
    // drive real delivery. Production-safe + inert unless a delivery row carries
    // `provider='push_stub'`. Mirrors the fresh-environment app server env below.
    OM_ENABLE_PUSH_STUB_ADAPTER: process.env.OM_ENABLE_PUSH_STUB_ADAPTER ?? '1',
    // Swap the FCM/APNs/Expo SDK clients for network-free fakes so the REAL provider
    // adapters run end-to-end. Unlike `push_stub` (which replaces the whole adapter),
    // this replaces only each SDK client. Mirrors the fresh-environment env below.
    OM_PUSH_FAKE_PROVIDERS: process.env.OM_PUSH_FAKE_PROVIDERS ?? '1',
    // Expo's receipt reaper ignores rows younger than 15 minutes by default, which no
    // integration test can wait out. Poll immediately instead.
    OM_PUSH_RECEIPT_MIN_AGE_MINUTES: process.env.OM_PUSH_RECEIPT_MIN_AGE_MINUTES ?? '0',
    // Tests assert on access_logs immediately after CRUD reads; keep the
    // blocking write path on inside the integration runtime so tests do
    // not have to call flushPendingCrudAccessLogs() explicitly.
    OM_CRUD_ACCESS_LOG_BLOCKING: process.env.OM_CRUD_ACCESS_LOG_BLOCKING ?? '1',
    OM_WEBHOOKS_ALLOW_PRIVATE_URLS: process.env.OM_WEBHOOKS_ALLOW_PRIVATE_URLS ?? '1',
    // TC-ONB-001/002 drive the self-service signup flow, whose routes are not
    // mounted while the feature is off. `apps/mercato/.env` ships it disabled,
    // so both specs 404'd on every local run while CI stayed green — it exports
    // the var at the workflow level, the same gap the MOCK_INBOUND_WEBHOOK_SECRET
    // note below describes. Keep in sync with the app-server env block.
    SELF_SERVICE_ONBOARDING_ENABLED: process.env.SELF_SERVICE_ONBOARDING_ENABLED ?? 'true',
    // Keep the bus in the test process (used by in-test queue-drain helpers)
    // on the same delivery mode as the app server it drives: inline persistent
    // delivery so event side effects are deterministic for assertions. See the
    // matching OM_EVENTS_SINGLE_DELIVERY note on the app server environment below.
    OM_EVENTS_SINGLE_DELIVERY: process.env.OM_EVENTS_SINGLE_DELIVERY ?? 'false',
    ENABLE_CRUD_API_CACHE: 'true',
    MOCK_GATEWAY_WEBHOOK_SECRET: 'open-mercato-mock-dev-webhook-secret',
    MOCK_CARRIER_WEBHOOK_SECRET: 'open-mercato-mock-dev-carrier-webhook-secret',
    MOCK_INBOUND_WEBHOOK_SECRET: 'open-mercato-mock-dev-inbound-webhook-secret',
    NEXT_PUBLIC_UMES_DEVTOOLS: 'true',
    CI: 'true',
    TENANT_DATA_ENCRYPTION_FALLBACK_KEY: process.env.TENANT_DATA_ENCRYPTION_FALLBACK_KEY ?? 'om-ephemeral-integration-fallback-key',
    OM_CLI_QUIET: '1',
    MERCATO_QUIET: '1',
    QUEUE_BASE_DIR: queueBaseDir,
    [PRIVATE_ATTACHMENTS_PARTITION_ENV_KEY]:
      process.env[PRIVATE_ATTACHMENTS_PARTITION_ENV_KEY] ?? privateAttachmentsRoot,
    NODE_NO_WARNINGS: '1',
  })
}

function resolvePrivateAttachmentsRootForQueueBaseDir(queueBaseDir: string): string {
  const resolvedQueueBaseDir = path.resolve(queueBaseDir)
  const queueParent = path.dirname(resolvedQueueBaseDir)
  if (path.basename(resolvedQueueBaseDir) === 'queue' && path.basename(queueParent) === '.mercato') {
    const queueAppDirectory = path.dirname(queueParent)
    if (isLikelyNextAppDirectory(queueAppDirectory)) {
      return path.join(queueAppDirectory, 'storage', 'attachments', 'privateAttachments')
    }
  }
  return EPHEMERAL_PRIVATE_ATTACHMENTS_ROOT
}

export async function tryReuseExistingEnvironment(options: EphemeralRuntimeOptions): Promise<EphemeralEnvironmentHandle | null> {
  const state = await readEphemeralEnvironmentState()
  if (!state) {
    return null
  }

  const unavailable = await isEnvironmentUnavailable(state.baseUrl)
  if (unavailable) {
    console.log(`[${options.logPrefix}] Found stale ephemeral state. Clearing ${EPHEMERAL_ENV_FILE_PATH}.`)
    await clearEphemeralEnvironmentState()
    return null
  }

  const cacheTtlSeconds = resolveBuildCacheTtlSeconds(options.logPrefix)
  const startedAtMs = Date.parse(state.startedAt)
  if (Number.isFinite(startedAtMs)) {
    const environmentAgeSeconds = Math.floor((Date.now() - startedAtMs) / 1000)
    if (environmentAgeSeconds > cacheTtlSeconds) {
      console.log(
        `[${options.logPrefix}] Existing ephemeral environment is ${environmentAgeSeconds}s old, exceeding ${BUILD_CACHE_TTL_ENV_VAR}=${cacheTtlSeconds}s. Rebuilding.`,
      )
      await clearEphemeralEnvironmentState()
      return null
    }

    const sourceChangedSinceStart = await hasBuildInputChangesSince(startedAtMs)
    if (sourceChangedSinceStart) {
      console.log(
        `[${options.logPrefix}] Source files changed since the current ephemeral environment started. Rebuilding.`,
      )
      await clearEphemeralEnvironmentState()
      return null
    }
  }

  console.log(`[${options.logPrefix}] Reusing existing ephemeral environment at ${state.baseUrl}.`)
  return {
    baseUrl: state.baseUrl,
    port: state.port,
    databaseUrl: state.databaseUrl,
    commandEnvironment: buildReusableEnvironment(
      state.baseUrl,
      state.databaseUrl,
      state.queueBaseDir,
    ),
    ownedByCurrentProcess: false,
    stop: async () => {},
  }
}

export async function waitForApplicationReadiness(
  baseUrl: string,
  appProcess: CapturedOutputProcess,
  options: { timeoutMs: number; intervalMs?: number; stabilizationMs?: number },
): Promise<void> {
  const startTimestamp = Date.now()
  const intervalMs = options.intervalMs ?? APP_READY_INTERVAL_MS
  const readinessStabilizationMs = options.stabilizationMs ?? 600
  let lastProbe: ApplicationReadinessProbeResult | null = null

  // Wrap process exit into a single never-rejecting promise so we can race it without piling up
  // rejection handlers or losing the exit code across loop iterations.
  let exitCode: number | null = null
  const exitSignal = getProcessExitPromise(appProcess).then(
    (code) => {
      exitCode = code ?? null
      return { exited: true as const }
    },
    () => {
      exitCode = null
      return { exited: true as const }
    },
  )
  const exitError = () => {
    const capturedOutput = appProcess.readCapturedOutput?.().trim()
    const capturedOutputTail = capturedOutput
      ? `\nCaptured output:\n${capturedOutput.split('\n').slice(-20).join('\n')}`
      : ''
    return new Error(
      `Application process exited before readiness check (exit ${exitCode ?? 'unknown'})${capturedOutputTail}`,
    )
  }

  while (Date.now() - startTimestamp < options.timeoutMs) {
    // Run one probe cycle to completion before starting the next. Overlapping cycles (the previous
    // race-against-a-1s-tick design) abandoned slow probes without cancelling them, so every second
    // a fresh /api/auth/login attempt piled onto the most expensive endpoint — amplifying the very
    // contention that delays readiness when 15 ephemeral shards boot in parallel. Each fetch is
    // independently bounded by fetchWithTimeout, so a stuck connection cannot stall the cycle.
    const cycle = await Promise.race([
      probeApplicationReadiness(baseUrl).then((probe) => ({ probe })),
      exitSignal,
    ])

    if ('exited' in cycle) {
      throw exitError()
    }

    lastProbe = cycle.probe
    if (cycle.probe.ready) {
      const processExited = await Promise.race([
        exitSignal.then(() => true),
        delay(readinessStabilizationMs).then(() => false),
      ])
      if (processExited) {
        throw new Error('Application process exited immediately after readiness probe.')
      }
      return
    }

    const remainingMs = options.timeoutMs - (Date.now() - startTimestamp)
    if (remainingMs <= 0) break
    const waited = await Promise.race([
      exitSignal,
      delay(Math.min(intervalMs, remainingMs)).then(() => null),
    ])
    if (waited && 'exited' in waited) {
      throw exitError()
    }
  }

  const lastFrontendDetail = lastProbe?.frontend.detail ?? 'GET /login was never observed'
  const lastBackendDetail = lastProbe?.backend.detail ?? 'POST /api/auth/login was never observed'
  const lastAuthenticatedDetail = lastProbe?.authenticated.detail ?? 'Authenticated API probe was never observed'
  const lastBackendBrowserAuthDetail = lastProbe?.backendBrowserAuth.detail ?? 'Backend browser auth probe was never observed'
  throw new Error(
    `Application did not become ready within ${options.timeoutMs / 1000} seconds. ` +
    `Last probe: ${lastFrontendDetail}; ${lastBackendDetail}; ${lastAuthenticatedDetail}; ${lastBackendBrowserAuthDetail}`,
  )
}

export function parseEphemeralAppOptions(rawArgs: string[]): EphemeralAppOptions {
  let verbose = false
  let forceRebuild = false
  let reuseExisting = true

  for (const argument of rawArgs) {
    if (argument === '--verbose') {
      verbose = true
      continue
    }
    if (argument === '--force-rebuild') {
      forceRebuild = true
      continue
    }
    if (argument === '--no-reuse-env') {
      reuseExisting = false
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }

  return {
    verbose,
    forceRebuild,
    reuseExisting,
  }
}

async function isEnvironmentUnavailable(baseUrl: string): Promise<boolean> {
  const readiness = await probeApplicationReadiness(baseUrl)
  return !readiness.ready
}

export async function startEphemeralEnvironment(options: EphemeralRuntimeOptions): Promise<EphemeralEnvironmentHandle> {
  assertNode24Runtime()

  // Auto-detect Docker socket from active context for non-standard setups (e.g., Colima)
  const dockerConfig = await resolveDockerHostFromContext(options.logPrefix)
  if (dockerConfig) {
    process.env.DOCKER_HOST = dockerConfig.dockerHost
    process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = dockerConfig.socketOverride
  }

  await assertContainerRuntimeAvailable()

  const setupLock = await acquireEphemeralEnvironmentLock(options.logPrefix)
  try {
    const existingStateBeforeReuseAttempt = await readEphemeralEnvironmentState()
    if (options.reuseExisting === false) {
      console.log(
        `[${options.logPrefix}] --no-reuse-env enabled. Skipping reuse checks and starting a new ephemeral environment.`,
      )
    }
    if (options.reuseExisting !== false) {
      const existingEnvironment = await tryReuseExistingEnvironment(options)
      if (existingEnvironment) {
        return existingEnvironment
      }
    }

    const shouldUseIsolatedPort = shouldUseIsolatedPortForFreshEnvironment({
      reuseExisting: options.reuseExisting,
      existingStateBeforeReuseAttempt,
    })
    const applicationPort = shouldUseIsolatedPort
      ? await getFreePort()
      : await getPreferredPort(DEFAULT_EPHEMERAL_APP_PORT)
    if (options.reuseExisting === false) {
      console.log(
        `[${options.logPrefix}] Starting a fresh ephemeral instance on isolated port ${applicationPort} because --no-reuse-env is enabled.`,
      )
    } else if (shouldUseIsolatedPort) {
      console.log(
        `[${options.logPrefix}] Existing ephemeral environment could not be reused. Starting a fresh instance on isolated port ${applicationPort}.`,
      )
    }
    const applicationBaseUrl = `http://127.0.0.1:${applicationPort}`
    const databaseName = 'mercato_test'
    const databaseUser = 'mercato'
    const databasePassword = 'secret'

    const { GenericContainer } = await import('testcontainers')
    const databaseContainer = await new GenericContainer(resolveEphemeralPostgresImage())
      .withEnvironment({
        POSTGRES_DB: databaseName,
        POSTGRES_USER: databaseUser,
        POSTGRES_PASSWORD: databasePassword,
      })
      // Guarantee the pgvector (and pgcrypto) extensions exist in the fresh database before the
      // app boots, so vector-search code paths and `CREATE EXTENSION vector` succeed. The
      // Postgres entrypoint runs *.sql files under /docker-entrypoint-initdb.d/ on first init.
      .withCopyContentToContainer([
        {
          content: ephemeralPostgresInitSql(),
          target: '/docker-entrypoint-initdb.d/00-open-mercato-extensions.sql',
        },
      ])
      .withExposedPorts(5432)
      .start()

    const databaseHost = databaseContainer.getHost()
    const databasePort = databaseContainer.getMappedPort(5432)
    const databaseUrl = `postgres://${databaseUser}:${databasePassword}@${databaseHost}:${databasePort}/${databaseName}`
    // Remove the WAL/SHM sidecars together with the main DB file: a fresh
    // sqlite database paired with a stale -shm/-wal from a previous run fails
    // to initialize, and the cache service silently falls back to per-process
    // memory — the app then serves stale CRUD reads that queue workers can no
    // longer invalidate cross-process (TC-CRM-028/079, TC-SX-001 staleness).
    await rm(EPHEMERAL_CACHE_DB_PATH, { force: true }).catch(() => undefined)
    await rm(`${EPHEMERAL_CACHE_DB_PATH}-wal`, { force: true }).catch(() => undefined)
    await rm(`${EPHEMERAL_CACHE_DB_PATH}-shm`, { force: true }).catch(() => undefined)
    await rm(EPHEMERAL_QUEUE_BASE_DIR, { recursive: true, force: true }).catch(() => undefined)
    const enterpriseModulesFlag = process.env.OM_ENABLE_ENTERPRISE_MODULES ?? 'false'
    const commandEnvironment = buildEnvironment({
      DATABASE_URL: databaseUrl,
      CACHE_STRATEGY: 'sqlite',
      CACHE_SQLITE_PATH: EPHEMERAL_CACHE_DB_PATH,
      BASE_URL: applicationBaseUrl,
      APP_URL: applicationBaseUrl,
      NEXT_PUBLIC_APP_URL: applicationBaseUrl,
      PLATFORM_PORTAL_BASE_URL: applicationBaseUrl,
      JWT_SECRET: process.env.JWT_SECRET ?? 'om-ephemeral-integration-jwt-secret',
      OM_SECURITY_MFA_SETUP_SECRET: process.env.OM_SECURITY_MFA_SETUP_SECRET ?? 'om-ephemeral-integration-mfa-setup-secret',
      NODE_ENV: 'production',
      // See the auth-probe block above: pin derived-user passwords to the
      // documented 'secret' so the ephemeral login probe converges under
      // NODE_ENV=production.
      OM_INIT_ADMIN_PASSWORD: process.env.OM_INIT_ADMIN_PASSWORD ?? 'secret',
      OM_INIT_EMPLOYEE_PASSWORD: process.env.OM_INIT_EMPLOYEE_PASSWORD ?? 'secret',
      // Pool sizing for the ephemeral integration runtime. Defaults were once
      // very aggressive (max=5, idle=1000) which exposed flaky 'timeout exceeded
      // when trying to connect' errors on `progressService.createJob`-backed
      // endpoints (sync_excel.import, data_sync.run, progress.jobs) — each
      // request acquires a transaction connection plus a separate connection
      // for the encryption subscriber's fetchMap probe, and with 1s idle close
      // the pool thrashes faster than pg-pool can repopulate. These values
      // still keep the pool tighter than production but give enough headroom
      // for the legitimate query bursts.
      DB_POOL_MIN: '2',
      DB_POOL_MAX: '20',
      DB_POOL_IDLE_TIMEOUT: '10000',
      DB_POOL_ACQUIRE_TIMEOUT: '15000',
      DB_IDLE_SESSION_TIMEOUT_MS: '30000',
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '30000',
      OM_INTEGRATION_TEST: 'true',
      OM_ENABLE_ENTERPRISE_MODULES: enterpriseModulesFlag,
      OM_ENABLE_ENTERPRISE_MODULES_SSO: process.env.OM_ENABLE_ENTERPRISE_MODULES_SSO ?? enterpriseModulesFlag,
      OM_ENABLE_ENTERPRISE_MODULES_SECURITY: process.env.OM_ENABLE_ENTERPRISE_MODULES_SECURITY ?? enterpriseModulesFlag,
      OM_TEST_MODE: '1',
      OM_TEST_EMAIL_CAPTURE_PATH: process.env.OM_TEST_EMAIL_CAPTURE_PATH ?? EPHEMERAL_EMAIL_CAPTURE_PATH,
      OM_TEST_AUTH_RATE_LIMIT_MODE: 'opt-in',
      // Browser RUM is an environment-wide env switch, so without a per-request opt-in a spec
      // could only cover the enabled path by booting the OTel web SDK on every page of every
      // other spec. Same shape as the auth rate-limit escape hatch above: inert unless a request
      // also carries the `om_test_browser_telemetry=on` cookie, which only TC-TELEMETRY-002 sets.
      OM_TEST_BROWSER_TELEMETRY_MODE: 'opt-in',
      OM_ENABLE_TEST_CHANNEL_SEEDING: 'true',
      OM_ENABLE_TEST_EMAIL_CAPTURE_DELIVERY: 'true',
      OM_TEST_SYSTEM_EMAIL_CAPTURE_PATH: EPHEMERAL_SYSTEM_EMAIL_CAPTURE_PATH,
      OM_TEST_EMAIL_CAPTURE_ACCESS_TOKEN: TEST_EMAIL_CAPTURE_ACCESS_TOKEN,
      OM_TEST_EMAIL_CAPTURE_CORRELATION_TOKEN: TEST_EMAIL_CAPTURE_CORRELATION_TOKEN,
      SYSTEM_EMAIL_PROVIDER: '__test_seed__',
      EMAIL_FROM: process.env.EMAIL_FROM ?? 'system@test-seed.local',
      NOTIFICATIONS_EMAIL_FROM: process.env.NOTIFICATIONS_EMAIL_FROM ?? 'notifications@test-seed.local',
      ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? 'admin@test-seed.local',
      // Register the network-free `push_stub` channel adapter so push integration
      // specs (TC-PUSH-003) can drive the strategy → delivery-row → send-push worker
      // → sendMessage chain end-to-end without a real FCM/APNs/Expo provider. The
      // adapter is production-safe (registered only under this flag) and inert unless
      // a delivery row carries `provider='push_stub'` — i.e. a test seeded a matching
      // push channel + device. Applies to the app server, the test process, and
      // any drain/worker child that inherits this environment.
      OM_ENABLE_PUSH_STUB_ADAPTER: process.env.OM_ENABLE_PUSH_STUB_ADAPTER ?? '1',
      // Swap the FCM/APNs/Expo SDK clients for network-free fakes (TC-CHANNEL-PUSH-005+) so the REAL
      // provider adapters — native message construction, credential parsing, client caching, and every
      // error → `device_unregistered` mapping — run end-to-end without live keys. Unlike
      // `push_stub`, which replaces the whole adapter, this replaces only each SDK client, and is
      // registered only under this flag. Applies to the app server, the test process, and any
      // drain/worker child that inherits this environment.
      OM_PUSH_FAKE_PROVIDERS: process.env.OM_PUSH_FAKE_PROVIDERS ?? '1',
      // Expo's receipt reaper ignores rows younger than 15 minutes by default (it polls a real
      // provider's async receipts). No integration test can wait that out — poll immediately.
      OM_PUSH_RECEIPT_MIN_AGE_MINUTES: process.env.OM_PUSH_RECEIPT_MIN_AGE_MINUTES ?? '0',
      // Delivery stays ON here (it was '1' before the pluggable-provider work) because
      // `SYSTEM_EMAIL_PROVIDER='__test_seed__'` above routes every send into the local
      // capture file rather than a network provider. The email integration specs assert
      // on those captured messages, so disabling delivery would black-hole them.
      OM_DISABLE_EMAIL_DELIVERY: '0',
      OM_WEBHOOKS_ALLOW_PRIVATE_URLS: process.env.OM_WEBHOOKS_ALLOW_PRIVATE_URLS ?? '1',
      // Read at build time as well as at runtime, so this block has to carry it:
      // the app build and `yarn start` both run with this environment. See the
      // matching note on the test-process env block above.
      SELF_SERVICE_ONBOARDING_ENABLED: process.env.SELF_SERVICE_ONBOARDING_ENABLED ?? 'true',
      ENABLE_CRUD_API_CACHE: 'true',
      MOCK_GATEWAY_WEBHOOK_SECRET: 'open-mercato-mock-dev-webhook-secret',
      MOCK_CARRIER_WEBHOOK_SECRET: 'open-mercato-mock-dev-carrier-webhook-secret',
      // The mock inbound adapter refuses the dev-secret fallback under
      // NODE_ENV=production; without this the app 400s every mock_inbound
      // verification and the TC-WEBHOOK suite fails locally (CI exports the
      // var at the workflow level, masking the gap). Keep in sync with the
      // test-process env block above.
      MOCK_INBOUND_WEBHOOK_SECRET: 'open-mercato-mock-dev-inbound-webhook-secret',
      NEXT_PUBLIC_UMES_DEVTOOLS: 'true',
      CI: 'true',
      TENANT_DATA_ENCRYPTION_FALLBACK_KEY: process.env.TENANT_DATA_ENCRYPTION_FALLBACK_KEY ?? 'om-ephemeral-integration-fallback-key',
      AUTO_SPAWN_WORKERS: process.env.AUTO_SPAWN_WORKERS ?? 'true',
      // Process persistent event subscribers INLINE in the request that emits
      // the event (legacy dual-dispatch), rather than the production default of
      // worker-only single delivery. Integration specs assert event side effects
      // (sync mappings, workflow-trigger instances, notifications) immediately
      // after the emitting API call and poll for them on short budgets; routing
      // those subscribers through the async events worker makes the side effect
      // race the poll under the 15-shard CI load, which surfaced as flaky
      // timeouts in TC-CRM-028 (inbound sync mapping) and TC-WF-008 (event-
      // triggered workflow) once single-delivery became default-ON. Inline
      // delivery makes the side effects deterministic for tests; production keeps
      // the single-delivery default. Honor an explicit override if the caller set one.
      OM_EVENTS_SINGLE_DELIVERY: process.env.OM_EVENTS_SINGLE_DELIVERY ?? 'false',
      AUTO_SPAWN_SCHEDULER: 'false',
      // Hide the demo feedback floating action button — it lives at
      // `fixed bottom-6 right-6 z-banner` and consistently intercepts pointer
      // events on row-action menus and other bottom-of-viewport UI elements
      // (e.g. TC-WF-006 Delete menuitem click). The widget is already gated
      // on `DEMO_MODE !== 'false'` in the backend layout, so opting out here
      // only affects the integration test runtime — dev + prod stay unchanged.
      DEMO_MODE: 'false',
      // Disable the feature-toggle resolution cache. Tests flip overrides
      // (e.g. example_customers_sync enabled/bidirectional) between cases; the
      // 1-minute resolution cache can serve a stale value across set/clear
      // under fast churn, which made the example.todo.* persistent subscribers
      // skip enqueueing inbound sync jobs (TC-CRM-028 inbound trio flake).
      // Fresh DB reads make flag-gated sync deterministic in tests only.
      OM_FEATURE_TOGGLES_CACHE_DISABLED: '1',
      OM_CLI_QUIET: '1',
      MERCATO_QUIET: '1',
      QUEUE_BASE_DIR: EPHEMERAL_QUEUE_BASE_DIR,
      [PRIVATE_ATTACHMENTS_PARTITION_ENV_KEY]:
        process.env[PRIVATE_ATTACHMENTS_PARTITION_ENV_KEY] ?? EPHEMERAL_PRIVATE_ATTACHMENTS_ROOT,
      NODE_NO_WARNINGS: '1',
      PORT: String(applicationPort),
    })

    const runtimeLock = await acquireEphemeralRuntimeLock(options.logPrefix)
    let applicationProcess: CapturedOutputProcess | null = null
    let isStopped = false
    let shutdownHandlers: EphemeralShutdownHandlers | null = null
    const stop = async (): Promise<void> => {
      if (isStopped) return
      isStopped = true
      try {
        if (applicationProcess && !applicationProcess.killed) {
          try {
            await terminateProcessTree(applicationProcess)
          } catch (error) {
            // `killProcessTreeIfRunning` rethrows anything that is not `ESRCH`, and this call sits
            // ahead of the container and state cleanup. A kill that fails must not strand the
            // Postgres container and the state file too — report it and finish tearing down.
            console.error(`[${options.logPrefix}] Failed to terminate the application process tree:`, error)
          }
        }
        await databaseContainer.stop()
        await clearEphemeralEnvironmentState()
      } finally {
        await runtimeLock.release()
        shutdownHandlers?.dispose()
      }
    }
    shutdownHandlers = registerEphemeralShutdownHandlers({
      stop,
      onSignal: (signal) =>
        console.log(`[${options.logPrefix}] Received ${signal}, stopping ephemeral environment...`),
      // Deliberately not guarded on `isStopped`: `startEphemeralEnvironment`'s own catch already ran
      // `stop()` before rethrowing, so the guard made the sweep dead on exactly the paths that need
      // it. After a successful `stop()` the extra group kill is a harmless `ESRCH` this swallows.
      killApplicationTree: () => {
        const pid = applicationProcess?.pid
        if (!pid) return
        try {
          killProcessTree(pid, 'SIGKILL')
        } catch {}
      },
    })

    try {
      const appReadyTimeoutMs = resolveAppReadyTimeoutMs(options.logPrefix)
      const buildCacheTtlSeconds = resolveBuildCacheTtlSeconds(options.logPrefix)
      const environmentFingerprint = buildEnvironmentFingerprint(commandEnvironment)
      let sourceFingerprintValue: string | null = null
      let needsBuild = true
      let shouldPersistBuildCache = true

      try {
        sourceFingerprintValue = await buildSourceFingerprint()
        needsBuild = options.forceRebuild
          ? true
          : await shouldRebuildBuildArtifacts(buildCacheTtlSeconds, options.logPrefix, {
              environmentFingerprint,
              precomputedSourceFingerprint: sourceFingerprintValue ?? undefined,
            })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        shouldPersistBuildCache = false
        needsBuild = true
        sourceFingerprintValue = null
        console.warn(
          `[${options.logPrefix}] Build cache check failed (${message}). Rebuilding with cache bypass.`,
        )
      }

      console.log(`[${options.logPrefix}] Ephemeral database ready at ${databaseHost}:${databasePort}`)
      console.log(`[${options.logPrefix}] Initializing application data (includes migrations)...`)
      await runTimedStep(options.logPrefix, 'Initializing application data', { expectedSeconds: 45 }, async () =>
        runYarnCommand(['initialize'], commandEnvironment, {
          silent: !options.verbose,
        }, appDirectory))

      if (!needsBuild) {
        console.log(
          `[${options.logPrefix}] Build cache valid (within ${BUILD_CACHE_TTL_ENV_VAR}=${buildCacheTtlSeconds}s). Skipping build pipeline.`,
        )
      } else {
        if (options.forceRebuild) {
          console.log(`[${options.logPrefix}] --force-rebuild enabled. Running full build pipeline.`)
        } else {
          console.log(`[${options.logPrefix}] Build artifacts missing, stale, or out of date; rebuilding artifacts.`)
        }
        if (PROJECT_SUPPORTS_PACKAGE_BUILDS) {
          console.log(`[${options.logPrefix}] Building packages...`)
          await runTimedStep(options.logPrefix, 'Building packages', { expectedSeconds: 20 }, async () =>
            runYarnCommand(['build:packages'], commandEnvironment, {
              silent: !options.verbose,
            }))
        } else {
          console.log(`[${options.logPrefix}] Skipping package build step (no build:packages script at project root).`)
        }

        console.log(`[${options.logPrefix}] Regenerating module artifacts...`)
        await rm(APP_MODULES_CHECKSUM_PATH, {
          force: true,
        })
        await runTimedStep(options.logPrefix, 'Regenerating module artifacts', { expectedSeconds: 8 }, async () =>
          runYarnCommand(['generate'], commandEnvironment, {
            silent: !options.verbose,
          }, appDirectory))

        if (PROJECT_SUPPORTS_PACKAGE_BUILDS) {
          console.log(`[${options.logPrefix}] Rebuilding packages after generation...`)
          await runTimedStep(options.logPrefix, 'Rebuilding packages after generation', { expectedSeconds: 20 }, async () =>
            runYarnCommand(['build:packages'], commandEnvironment, {
              silent: !options.verbose,
            }))
        }

        console.log(`[${options.logPrefix}] Building application...`)
        await resetNextBuildOutputDirectories(options.logPrefix)
        await runTimedStep(options.logPrefix, 'Building application', { expectedSeconds: 76 }, async () =>
          runYarnCommand(['build'], commandEnvironment, {
            silent: !options.verbose,
          }, appDirectory))
      }

      if (shouldPersistBuildCache && sourceFingerprintValue) {
        await writeBuildCacheState(sourceFingerprintValue, { environmentFingerprint })
      }

      console.log(`[${options.logPrefix}] Starting application on ${applicationBaseUrl}...`)
      const startedAppProcess = startYarnCommand(['start'], commandEnvironment, {
        silent: !options.verbose,
        detached: true,
      }, appDirectory)
      applicationProcess = startedAppProcess

      await runTimedStep(
        options.logPrefix,
        'Waiting for application readiness',
        { expectedSeconds: Math.max(12, Math.ceil(appReadyTimeoutMs / 1000)) },
        async () =>
          waitForApplicationReadiness(applicationBaseUrl, startedAppProcess, {
            timeoutMs: appReadyTimeoutMs,
          }),
      )
      console.log(`[${options.logPrefix}] Application is ready at ${applicationBaseUrl}`)
      await writeEphemeralEnvironmentState({
        baseUrl: applicationBaseUrl,
        port: applicationPort,
        databaseUrl,
        queueBaseDir: EPHEMERAL_QUEUE_BASE_DIR,
        logPrefix: options.logPrefix,
      })
      return {
        baseUrl: applicationBaseUrl,
        port: applicationPort,
        databaseUrl,
        commandEnvironment,
        ownedByCurrentProcess: true,
        stop,
      }
    } catch (error) {
      await stop()
      throw error
    }
  } finally {
    await setupLock.release()
  }
}

// Interrupt handling belongs to `startEphemeralEnvironment`, which owns the detached tree and
// registers SIGINT/SIGTERM handlers for every run. Registering a second pair here would race them:
// both fire on the same signal, and this one's `process.exit()` would cut the environment's
// teardown short mid-await.
async function keepEnvironmentRunningForever(): Promise<void> {
  await new Promise<void>(() => {})
}

export async function runEphemeralAppForQa(rawArgs: string[]): Promise<void> {
  const options = parseEphemeralAppOptions(rawArgs)
  const environment = await startEphemeralEnvironment({
    verbose: options.verbose,
    forceRebuild: options.forceRebuild,
    reuseExisting: options.reuseExisting,
    logPrefix: 'ephemeral',
  })

  console.log(`[ephemeral] Ready for QA exploration at ${environment.baseUrl}`)
  console.log('[ephemeral] Point the e2e suite (e2e/) or any browser at this URL to avoid interference with other local instances.')
  console.log('[ephemeral] Default credentials: admin@acme.com / secret')
  if (environment.ownedByCurrentProcess) {
    console.log('[ephemeral] Press Ctrl+C to stop.')
  } else {
    console.log('[ephemeral] Reused existing environment. Press Ctrl+C to exit without stopping the shared runtime.')
  }

  await keepEnvironmentRunningForever()
}

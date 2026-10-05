import fs from 'node:fs'

export const PLAYWRIGHT_BROWSERS_DOCS_URL = 'https://playwright.dev/docs/browsers'

// The preflight honors PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH so containers can supply a system
// Chromium instead of Playwright's managed download; `chromium.executablePath()` knows nothing
// about it, so the override has to be checked first.
export function findChromiumPreflightFailure({
  env = process.env,
  resolveManagedExecutablePath,
  exists = fs.existsSync,
} = {}) {
  // Truthiness, not a trimmed value: the config branches on the raw variable, so a
  // whitespace-only setting reaches Playwright as an executable path and fails at launch.
  // Normalizing it here would let exactly that case slip past the guard.
  const override = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH

  if (override) {
    if (exists(override)) return null
    return {
      reason: 'override-missing',
      message: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH points at a binary that does not exist: ${override}`,
      remedies: [
        'Point PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH at an existing Chromium binary,',
        'or unset it to fall back to Playwright\'s managed browsers.',
      ],
    }
  }

  let managedExecutablePath = null
  try {
    managedExecutablePath = resolveManagedExecutablePath()
  } catch {
    managedExecutablePath = null
  }

  if (managedExecutablePath && exists(managedExecutablePath)) return null

  return {
    reason: 'managed-browser-missing',
    message: 'Playwright browsers are not installed. Run the following before retrying:',
    remedies: [
      'yarn playwright install',
      'yarn playwright install-deps   (Linux only, may require sudo)',
    ],
  }
}

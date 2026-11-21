import { defineConfig } from '@playwright/test'

/**
 * End-to-end verification against the deployed Exo shell.
 *
 * The plugin under test is either the local production build or the deployed
 * Pages build, selected via EXO_MANIFEST_URL. Workspace files are served
 * through request interception at a fake https origin, so the shell's folder
 * picker is exercised without a local server or interactive dialog.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 150_000,
  expect: { timeout: 25_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.EXO_SHELL_URL ?? 'https://mode777.github.io/exo-editor/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
      args: ['--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    },
  },
})

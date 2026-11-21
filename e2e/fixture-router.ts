/**
 * Serves the plugin build and the workspace fixture through Playwright request
 * interception at a fake https origin.
 *
 * A routed https origin avoids Chromium's local-network gate (the deployed
 * shell is a public page), needs no port, and keeps the plugin cross-origin to
 * the shell exactly as a plugin hosted by a different owner would be.
 */
import { readFileSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

export const FAKE_ORIGIN = 'https://exo-polyfork-e2e.test'
export const fakeManifestUrl = `${FAKE_ORIGIN}/exo-polyfork/exo-manifest.json`
export const fixtureBase = `${FAKE_ORIGIN}/fixtures`

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const distDir = join(repoRoot, 'plugin', 'dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function safeJoin(root: string, requestPath: string): string | null {
  const clean = normalize(requestPath).replace(/^([/\\])+/, '')
  const target = join(root, clean)
  return target === root || target.startsWith(root + sep) ? target : null
}

export async function installFixtureRoutes(page: Page): Promise<void> {
  await page.route(`${FAKE_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url())
    const path = decodeURIComponent(url.pathname)
    const headers = {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    }

    if (path === '/fixtures/files/exo.json') {
      const manifest = process.env.EXO_MANIFEST_URL ?? fakeManifestUrl
      await route.fulfill({
        status: 200,
        headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ schemaVersion: 1, plugins: [{ manifest, enabled: true }] }),
      })
      return
    }

    const source = path.startsWith('/exo-polyfork/')
      ? safeJoin(distDir, path.slice('/exo-polyfork/'.length))
      : null
    if (!source) {
      await route.fulfill({ status: 404, body: 'not found' })
      return
    }

    try {
      const body = readFileSync(source)
      await route.fulfill({
        status: 200,
        headers: {
          ...headers,
          'content-type': MIME[extname(source)] ?? 'application/octet-stream',
        },
        body,
      })
    } catch {
      await route.fulfill({ status: 404, body: 'not found' })
    }
  })
}

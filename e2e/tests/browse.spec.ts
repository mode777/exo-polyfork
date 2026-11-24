import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { fixtureBase, installFixtureRoutes } from '../fixture-router'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const fakeFsaSource = readFileSync(join(repoRoot, 'e2e', 'fake-fsa.js'), 'utf8')
const deployed = process.env.EXO_EXPECT_DEPLOYED === '1'
const iframeSelector = 'iframe[title="Assets — Polyfork"]'

async function waitForDeployedBuild(): Promise<void> {
  const manifestUrl = process.env.EXO_MANIFEST_URL
  if (!manifestUrl) throw new Error('EXO_EXPECT_DEPLOYED requires EXO_MANIFEST_URL')
  const pluginBase = manifestUrl.replace(/\/exo-manifest\.json$/, '')

  const pages = ['plugin.html', 'panel.html', 'preview.html'].map((page) => {
    const html = readFileSync(join(repoRoot, 'plugin', 'dist', page), 'utf8')
    const match = html.match(/assets\/[A-Za-z0-9_.-]+\.js/)
    if (!match) throw new Error(`Local plugin/dist/${page} has no hashed script asset.`)
    return { page, asset: match[0] }
  })

  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    try {
      const manifestResponse = await fetch(manifestUrl, { cache: 'no-store' })
      if (manifestResponse.ok) {
        const manifest = (await manifestResponse.json()) as { id?: string }
        if (manifest.id === 'dev.polyfork.assets') {
          const checks = await Promise.all(
            pages.map(async ({ page, asset }) => {
              const htmlResponse = await fetch(`${pluginBase}/${page}`, { cache: 'no-store' })
              if (!htmlResponse.ok) return false
              const html = await htmlResponse.text()
              if (!html.includes(asset)) return false
              const assetResponse = await fetch(`${pluginBase}/${asset}`, { cache: 'no-store' })
              return assetResponse.ok
            }),
          )
          if (checks.every(Boolean)) return
        }
      }
    } catch {
      // GitHub Pages may still be propagating the deployment.
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  throw new Error('The deployed plugin never served this build.')
}

async function gotoShell(page: Page): Promise<void> {
  let lastStatus = 0
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await page.goto('./', { waitUntil: 'domcontentloaded' }).catch(() => null)
    lastStatus = response?.status() ?? 0
    const missing = await page
      .evaluate(
        () => document.body.textContent?.includes("There isn't a GitHub Pages site here") ?? true,
      )
      .catch(() => true)
    if (!missing) return
    await page.waitForTimeout(10_000)
  }
  throw new Error(`Exo shell did not become available (last navigation status ${lastStatus}).`)
}

async function bootstrap(page: Page): Promise<void> {
  const config = {
    base: fixtureBase,
    name: 'e2e-workspace',
    paths: ['exo.json', 'notes.txt'],
  }
  await installFixtureRoutes(page)
  await page.addInitScript({ content: fakeFsaSource })
  await page.addInitScript({ content: `window.__EXO_E2E_CONFIG__ = ${JSON.stringify(config)};` })
  page.on('console', (message) => {
    if (message.text().includes('[polyfork]')) console.log('[e2e console]', message.text())
  })
  page.on('requestfailed', (request) => {
    if (request.url().includes('exo-polyfork-e2e.test')) {
      console.log('[e2e requestfailed]', request.url(), request.failure()?.errorText)
    }
  })

  await gotoShell(page)
  await page.getByRole('button', { name: 'Open Folder…' }).click()

  const consentTitle = page.locator('#exo-consent-title')
  await expect(consentTitle).toBeVisible({ timeout: 60_000 })
  await expect(consentTitle).toContainText('Polyfork')

  const consent = page.locator('.exo-consent')
  await expect(consent).toContainText('Assets')
  await expect(consent).toContainText('Asset Preview')
  await expect(consent).toContainText('Parameters')
  await expect(consent).toContainText('Left side bar, with an activity-bar item.')
  await expect(consent).toContainText('Right side bar, opened from the view picker.')
  await expect(consent).toContainText('Read-only tab in the document area.')
  await expect(consent).toContainText('events:subscribe')
  await expect(consent).toContainText('workspace:read')
  await expect(consent).toContainText('workspace:write')
  await expect(consent).toContainText('This plugin can write to your workspace when you save.')
  if (deployed) {
    await expect(consent).toContainText('This plugin is served from the same origin as the shell.')
  } else {
    await expect(consent).not.toContainText(
      'This plugin is served from the same origin as the shell.',
    )
  }

  await page.getByRole('button', { name: 'Allow plugin' }).click()
  await expect(page.getByText('e2e-workspace · folder')).toBeVisible({ timeout: 30_000 })
}

async function openPanel(page: Page): Promise<FrameLocator> {
  // Registration is asynchronous and the deployed manifest is same-origin, so
  // the activity-bar item can appear a moment after the workspace is ready.
  const item = page
    .getByRole('tab', { name: 'Assets — Polyfork' })
    .or(page.getByRole('button', { name: 'Assets — Polyfork' }))
    .or(page.locator('[title="Assets — Polyfork"]'))
    .or(page.locator('[aria-label="Assets — Polyfork"]'))
    .first()

  await expect(item).toBeVisible({ timeout: 60_000 })
  await item.click()

  const frame = page.frameLocator(iframeSelector)
  await expect(frame.locator('.app')).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
  await expect(frame.locator('.asset-card:not(.is-skeleton)')).toHaveCount(20, {
    timeout: 90_000,
  })
  return frame
}

function assetApiRequest(page: Page, predicate: (url: URL) => boolean) {
  return page.waitForRequest((request) => {
    const url = request.url()
    if (!url.startsWith('https://polyfork.dev/api/assets')) return false
    return predicate(new URL(url))
  })
}

const previewIframeSelector = 'iframe[title="Asset Preview — Polyfork"]'

function previewFrameAt(page: Page, index: number): FrameLocator {
  return page.locator(previewIframeSelector).nth(index).contentFrame()
}

async function findPreviewFrame(page: Page, assetId: string): Promise<FrameLocator> {
  let match: FrameLocator | null = null
  await expect
    .poll(
      async () => {
        const count = await page.locator(previewIframeSelector).count()
        for (let index = 0; index < count; index += 1) {
          const frame = previewFrameAt(page, index)
          const current = await frame
            .locator('#preview')
            .getAttribute('data-asset-id', { timeout: 1_000 })
            .catch(() => null)
          if (current === assetId) {
            match = frame
            return true
          }
        }
        return false
      },
      { timeout: 90_000 },
    )
    .toBe(true)
  if (!match) throw new Error(`No preview frame is showing ${assetId}.`)
  return match
}

function previewTab(page: Page, index: number) {
  return page.getByRole('tab', { name: 'Asset Preview — Polyfork' }).nth(index)
}

async function readThumbnailCacheCount(frame: FrameLocator): Promise<number> {
  return frame.locator('body').evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('exo-polyfork-thumbnails', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<number>((resolve, reject) => {
        const transaction = db.transaction('thumbs', 'readonly')
        const request = transaction.objectStore('thumbs').count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  })
}

test('browses, filters, paginates and renders a missing thumbnail from the module', async ({
  page,
}) => {
  if (deployed) test.slow()
  if (deployed) await waitForDeployedBuild()

  const glbRequests: string[] = []
  const moduleRequests: string[] = []
  const consoleErrors: string[] = []

  page.on('request', (request) => {
    const url = request.url()
    if (/\.glb(?:$|\?)/i.test(url) || url.includes('-preview.glb')) glbRequests.push(url)
    if (url.startsWith('https://polyfork.dev/cdn/') && url.includes('.mjs')) {
      moduleRequests.push(url)
    }
  })
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (text.includes('favicon')) return
    consoleErrors.push(text)
  })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))

  await bootstrap(page)
  const frame = await openPanel(page)

  await test.step('panel chrome and initial page', async () => {
    await expect(frame.locator('.brand h1')).toHaveText('Polyfork')
    await expect(frame.locator('html')).toHaveAttribute('data-theme', /^(dark|light|high-contrast)$/)
    const theme = await frame.locator('html').evaluate((element) => ({
      token: getComputedStyle(element).getPropertyValue('--exo-bg').trim(),
      pageBackground: getComputedStyle(document.body).backgroundColor,
    }))
    expect(theme.token).not.toBe('')
    expect(theme.pageBackground).not.toBe('rgba(0, 0, 0, 0)')
    await expect(frame.locator('#status')).toContainText('assets')
    await expect(frame.locator('#page-info')).toHaveText(/Page 1 of \d+/)
    await expect(frame.locator('#thumbnail-canvas')).toHaveCount(1)
    await expect(frame.locator('#thumbnail-canvas')).toHaveAttribute('width', '512')
    await expect(frame.locator('body')).toHaveAttribute(
      'data-cache',
      deployed ? 'memory' : 'indexeddb',
    )
    await expect(frame.locator('img[data-source="polyfork"].is-loaded').first()).toBeVisible()

    if (process.env.EXO_SCREENSHOT === '1') {
      await expect(frame.locator('img[data-source="polyfork"].is-loaded').nth(1)).toBeVisible()
      mkdirSync(join(repoRoot, 'docs'), { recursive: true })
      await frame.locator('.app').screenshot({
        path: join(repoRoot, 'docs', 'screenshot.png'),
        animations: 'disabled',
      })
    }
  })

  await test.step('pagination keeps twenty assets per page', async () => {
    const firstOnPageOne = await frame.locator('.asset-card').first().getAttribute('data-asset-id')
    const secondPage = assetApiRequest(page, (url) => url.searchParams.get('page') === '2')

    await frame.locator('#next').click()
    await secondPage
    await expect(frame.locator('#page-info')).toHaveText(/Page 2 of \d+/)
    await expect(frame.locator('.asset-card:not(.is-skeleton)')).toHaveCount(20)

    const firstOnPageTwo = await frame.locator('.asset-card').first().getAttribute('data-asset-id')
    expect(firstOnPageTwo).not.toBe(firstOnPageOne)

    await frame.locator('#prev').click()
    await expect(frame.locator('#page-info')).toHaveText(/Page 1 of \d+/)
    await expect(frame.locator('.asset-card:not(.is-skeleton)')).toHaveCount(20)
  })

  await test.step('name filter', async () => {
    const chairRequest = assetApiRequest(page, (url) => url.searchParams.get('q') === 'chair')
    await frame.locator('#search').fill('chair')
    await chairRequest
    await expect(frame.locator('.asset-card:not(.is-skeleton)')).toHaveCount(20)
    await expect(frame.locator('#page-info')).toHaveText(/Page 1 of \d+/)
    await expect(
      frame.locator('.asset-title').filter({ hasText: /chair/i }).first(),
    ).toBeVisible()

    const cleared = assetApiRequest(page, (url) => url.searchParams.get('q') === null)
    await frame.locator('#search').fill('')
    await cleared
    await expect(frame.locator('.asset-card:not(.is-skeleton)')).toHaveCount(20)
  })

  await test.step('category filter', async () => {
    const buildingRequest = assetApiRequest(
      page,
      (url) => url.searchParams.get('class') === 'building',
    )
    await frame.locator('#category').selectOption('building')
    await buildingRequest
    await expect(
      frame.locator('.asset-card:not(.is-skeleton)[data-class="building"]'),
    ).toHaveCount(20)

    const cleared = assetApiRequest(page, (url) => url.searchParams.get('class') === null)
    await frame.locator('#category').selectOption('')
    await cleared
    await expect(frame.locator('.asset-card:not(.is-skeleton)')).toHaveCount(20)
  })

  await test.step('kit filter', async () => {
    await expect(frame.locator('#kit')).toBeEnabled()
    const kitId = 'medieval-village-kit-ca0b43'
    const kitRequest = assetApiRequest(page, (url) => url.searchParams.get('kit') === kitId)
    await frame.locator('#kit').selectOption(kitId)
    await kitRequest
    await expect(
      frame.locator(`.asset-card:not(.is-skeleton)[data-kit="${kitId}"]`),
    ).toHaveCount(20)
  })

  await test.step('exact id and module-rendered thumbnail', async () => {
    const clearedKit = assetApiRequest(page, (url) => url.searchParams.get('kit') === null)
    await frame.locator('#kit').selectOption('')
    await clearedKit

    await page.route('https://polyfork.dev/api/assets/stable-57d8b1', async (route) => {
      const response = await route.fetch()
      const json = (await response.json()) as { thumbnail?: string | null }
      json.thumbnail = null
      await route.fulfill({ response, json })
    })

    const exactRequest = page.waitForRequest(
      (request) => request.url() === 'https://polyfork.dev/api/assets/stable-57d8b1',
    )
    await frame.locator('#search').fill('stable-57d8b1')
    await exactRequest
    await expect(frame.locator('.asset-card:not(.is-skeleton)')).toHaveCount(1)
    await expect(frame.locator('#status')).toHaveText('Exact ID match')
    await expect(frame.locator('#page-info')).toHaveText('Page 1 of 1')
    await expect(frame.locator('#prev')).toBeDisabled()
    await expect(frame.locator('#next')).toBeDisabled()
    await expect(frame.locator('.asset-card')).toHaveAttribute(
      'data-asset-id',
      'stable-57d8b1',
    )

    const rendered = frame.locator('img[data-source="rendered"]')
    await expect(rendered).toBeVisible({ timeout: 90_000 })
    await expect(rendered).toHaveAttribute('src', /^blob:/)
    await expect(frame.locator('.thumb-badge')).toHaveText('3D')
    expect(moduleRequests.some((url) => url.endsWith('/stable-57d8b1.mjs'))).toBe(true)

    if (deployed) {
      await expect(frame.locator('body')).toHaveAttribute('data-cache', 'memory')
    } else {
      await expect
        .poll(() => readThumbnailCacheCount(frame), { timeout: 30_000 })
        .toBeGreaterThan(0)
    }

    if (process.env.EXO_SCREENSHOT === '1') {
      await frame.locator('.app').screenshot({
        path: join(repoRoot, 'docs', 'fallback.png'),
        animations: 'disabled',
      })
    }
  })

  const paramsFrame = page.frameLocator('iframe[title="Parameters — Polyfork"]')
  const previewA = previewFrameAt(page, 0)
  let previewB: FrameLocator | null = null
  let secondPreviewId = ''

  await test.step('selecting an asset opens the content-view preview and its parameters', async () => {
    const selectedTitle = (await frame.locator('.asset-title').first().innerText()).trim()
    const paramsRequest = page.waitForRequest(
      (request) =>
        request.url() === 'https://polyfork.dev/cdn/stable-57d8b1-params.json',
    )

    await frame.locator('.asset-card').first().click()

    await expect(
      page.locator('.exo-view-placeholder[aria-label="Asset Preview — Polyfork"]'),
    ).toHaveCount(1)
    await expect(page.locator('iframe[title="Asset Preview — Polyfork"]')).toHaveCount(1)
    await expect(page.locator('iframe[title="Parameters — Polyfork"]')).toHaveCount(1)
    await paramsRequest

    const preview = previewA.locator('#preview')
    await expect(preview).toHaveAttribute('data-asset-id', 'stable-57d8b1')
    await expect(preview).toHaveAttribute('data-phase', 'ready', { timeout: 90_000 })
    await expect(previewA.locator('#asset-title')).toHaveText(selectedTitle)
    await expect(previewA.locator('#asset-id')).toHaveText('stable-57d8b1')
    await expect(previewA.locator('#preview-canvas')).toBeVisible()
    await expect(previewA.locator('#preview-meta')).toContainText('Free')
    await expect(frame.locator('.asset-card')).toHaveAttribute('aria-current', 'true')

    const parameters = paramsFrame.locator('#parameters')
    await expect(parameters).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
    await expect(paramsFrame.locator('#params-id')).toHaveText('stable-57d8b1')
    await expect(
      paramsFrame.locator('.param-field[data-param-key="faction"] select'),
    ).toBeVisible()
    await expect(paramsFrame.locator('.param-field').first()).toBeVisible()

    if (process.env.EXO_SCREENSHOT === '1') {
      await previewA.locator('.preview').screenshot({
        path: join(repoRoot, 'docs', 'preview.png'),
        animations: 'disabled',
      })
      await paramsFrame.locator('.parameters').screenshot({
        path: join(repoRoot, 'docs', 'parameters.png'),
        animations: 'disabled',
      })
    }
  })

  await test.step('a parameter edit rebuilds the preview model', async () => {
    const preview = previewA.locator('#preview')
    const before = Number((await preview.getAttribute('data-params-revision')) ?? '0')

    await paramsFrame
      .locator('.param-field[data-param-key="faction"] select')
      .selectOption('wei')

    await expect(preview).toHaveAttribute('data-params', /"faction":"wei"/)
    await expect(preview).toHaveAttribute('data-params', /"ridge":"#688795"/)
    await expect(preview).toHaveAttribute('data-params', /"lacquer":"#749aa5"/)
    await expect
      .poll(async () => Number((await preview.getAttribute('data-params-revision')) ?? '0'))
      .toBeGreaterThan(before)
  })

  await test.step('dragging a slider streams several values', async () => {
    const preview = previewA.locator('#preview')
    const slider = paramsFrame.locator(
      '.param-field[data-param-key="roofPitch"] input[type="range"]',
    )
    const box = await slider.boundingBox()
    expect(box).not.toBeNull()
    if (!box) return

    const before = Number((await preview.getAttribute('data-params-revision')) ?? '0')
    const seen = new Set<string>()
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2)
    await page.mouse.down()
    for (let index = 1; index <= 8; index += 1) {
      await page.mouse.move(
        box.x + box.width * (0.2 + index * 0.06),
        box.y + box.height / 2,
      )
      await page.waitForTimeout(80)
      seen.add((await preview.getAttribute('data-params')) ?? '')
    }
    await page.mouse.up()

    expect(seen.size).toBeGreaterThan(3)
    await expect
      .poll(async () => Number((await preview.getAttribute('data-params-revision')) ?? '0'))
      .toBeGreaterThan(before)
  })

  await test.step('exports the current configuration as JSON and GLB', async () => {
    const preview = previewA.locator('#preview')
    const title = (await previewA.locator('#asset-title').innerText()).trim()
    const dialog = page.getByRole('dialog', { name: 'New File' })
    const nameInput = dialog.getByLabel('File name')

    await previewA.locator('#export-json').click()
    await expect(dialog).toBeVisible()
    await expect(nameInput).toHaveValue('stable-57d8b1.json')
    await expect(dialog).toContainText('Text content')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    await expect(previewA.locator('#export-status')).toContainText('/stable-57d8b1.json')

    const config = await page.evaluate(() => {
      const api = (
        window as unknown as {
          __EXO_E2E__: { text(path: string): string }
        }
      ).__EXO_E2E__
      return JSON.parse(api.text('/stable-57d8b1.json')) as {
        assetId: string
        title: string
        generator: string
        params: Record<string, unknown>
      }
    })
    expect(config.assetId).toBe('stable-57d8b1')
    expect(config.title).toBe(title)
    expect(config.generator).toBe('https://polyfork.dev/cdn/stable-57d8b1.mjs')
    expect(config.params.faction).toBe('wei')
    expect(typeof config.params.roofPitch).toBe('number')

    await expect(preview).toHaveAttribute('data-phase', 'ready')
    await previewA.locator('#export-glb').click()
    await expect(dialog).toBeVisible()
    await expect(nameInput).toHaveValue('stable-57d8b1.glb')
    await expect(dialog).toContainText('Binary content')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    await expect(previewA.locator('#export-status')).toContainText('/stable-57d8b1.glb')

    const glb = await page.evaluate(() => {
      const api = (
        window as unknown as {
          __EXO_E2E__: { bytes(path: string): number[] }
        }
      ).__EXO_E2E__
      return api.bytes('/stable-57d8b1.glb')
    })
    expect(glb.slice(0, 4)).toEqual([0x67, 0x6c, 0x54, 0x46])
    expect(glb.length).toBeGreaterThan(20)
  })

  await test.step('a second selection opens another preview with its own parameters', async () => {
    const cleared = assetApiRequest(page, (url) => url.searchParams.get('q') === null)
    await frame.locator('#search').fill('')
    await cleared
    await expect(frame.locator('.asset-card:not(.is-skeleton)')).toHaveCount(20)

    const next = frame.locator('.asset-card').nth(1)
    const nextTitle = (await next.locator('.asset-title').innerText()).trim()
    const nextId = await next.getAttribute('data-asset-id')
    if (!nextId) throw new Error('The second card has no asset id.')
    secondPreviewId = nextId
    await next.click()

    await expect(page.locator(previewIframeSelector)).toHaveCount(2, { timeout: 60_000 })
    previewB = await findPreviewFrame(page, nextId)
    await expect(previewB.locator('#preview')).toHaveAttribute('data-asset-id', nextId)
    await expect(previewB.locator('#asset-title')).toHaveText(nextTitle)
    await expect(paramsFrame.locator('#params-id')).toHaveText(nextId, { timeout: 60_000 })
    await expect(paramsFrame.locator('.param-field').first()).toBeVisible()

    await expect(previewA.locator('#preview')).toHaveAttribute('data-params', /"faction":"wei"/)
  })

  await test.step('switching preview tabs moves the shared parameters panel', async () => {
    await expect(previewTab(page, 0)).toBeVisible()
    await previewTab(page, 0).click()

    await expect(paramsFrame.locator('#params-id')).toHaveText('stable-57d8b1')
    await expect(paramsFrame.locator('#parameters')).toHaveAttribute('data-phase', 'ready')
    await expect(previewA.locator('#preview')).toHaveAttribute('data-params', /"faction":"wei"/)

    await previewTab(page, 1).click()
    await expect(paramsFrame.locator('#params-id')).toHaveText(secondPreviewId)
  })

  await test.step('a non-preview tab hides the parameters panel', async () => {
    await page.locator('[title="Explorer"]').first().click()
    const notes = page.getByRole('treeitem', { name: 'notes.txt' })
    await expect(notes).toBeVisible({ timeout: 30_000 })
    await notes.dblclick()
    await expect(page.getByRole('textbox', { name: /Editor for notes\.txt/ })).toBeVisible({
      timeout: 30_000,
    })

    if (!previewB) throw new Error('The second preview was not opened.')
    await expect(page.locator('iframe[title="Parameters — Polyfork"]')).toBeHidden({
      timeout: 30_000,
    })
  })

  await test.step('returning to a preview restores its parameters', async () => {
    await previewTab(page, 1).click()
    await expect(page.locator('iframe[title="Parameters — Polyfork"]')).toBeVisible({
      timeout: 30_000,
    })
    await expect(paramsFrame.locator('#parameters')).toHaveAttribute('data-phase', 'ready', {
      timeout: 60_000,
    })

    await previewTab(page, 0).click()
    await expect(paramsFrame.locator('#params-id')).toHaveText('stable-57d8b1')
    await expect(previewA.locator('#preview')).toHaveAttribute('data-params', /"faction":"wei"/)
  })

  await test.step('closing one preview keeps the other preview and its parameters', async () => {
    await previewTab(page, 1).click()
    await expect(paramsFrame.locator('#params-id')).toHaveText(secondPreviewId)
    await page
      .locator('[aria-label^="Close Asset Preview"]')
      .nth(1)
      .evaluate((element) => (element as HTMLElement).click())

    await expect(page.locator(previewIframeSelector)).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('iframe[title="Parameters — Polyfork"]')).toBeHidden({
      timeout: 30_000,
    })

    await previewTab(page, 0).click()
    await expect(page.locator('iframe[title="Parameters — Polyfork"]')).toBeVisible()
    await expect(paramsFrame.locator('#params-id')).toHaveText('stable-57d8b1')

    await page
      .locator('[aria-label^="Close Asset Preview"]')
      .first()
      .evaluate((element) => (element as HTMLElement).click())
    await expect(page.locator(previewIframeSelector)).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('iframe[title="Parameters — Polyfork"]')).toBeHidden({
      timeout: 30_000,
    })
  })

  await test.step('reopening a preview reveals the companion panel again', async () => {
    const assets = page
      .getByRole('tab', { name: 'Assets — Polyfork' })
      .or(page.getByRole('button', { name: 'Assets — Polyfork' }))
      .or(page.locator('[title="Assets — Polyfork"]'))
      .or(page.locator('[aria-label="Assets — Polyfork"]'))
      .first()
    await expect(assets).toBeVisible()
    await assets.click()
    await expect(frame.locator('.app')).toHaveAttribute('data-phase', 'ready')
    await frame.locator('.asset-card').nth(2).click()
    await expect(page.locator(previewIframeSelector)).toHaveCount(1, { timeout: 60_000 })
    await expect(page.locator('iframe[title="Parameters — Polyfork"]')).toBeVisible()
    await expect(paramsFrame.locator('#parameters')).toHaveAttribute('data-phase', 'ready', {
      timeout: 60_000,
    })
  })

  expect(glbRequests, `GLB requests were made: ${glbRequests.join(', ')}`).toEqual([])
  expect(consoleErrors, `Console errors: ${consoleErrors.join(' | ')}`).toEqual([])
})

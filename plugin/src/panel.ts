import { connectBrowserPlugin } from '@exo/plugin-sdk/browser'
import { ExoProtocolError, type ViewClient } from '@exo/plugin-sdk'
import {
  CATEGORY_OPTIONS,
  PAGE_SIZE,
  PolyforkError,
  fetchAssets,
  fetchKits,
  pageBounds,
  totalPages,
  type AssetFilters,
  type AssetPage,
  type PolyforkAsset,
  type PolyforkKit,
} from './api'
import { ThumbnailService } from './thumbnails'
import {
  ASSET_SELECTED_TOPIC,
  PREVIEW_CLOSED_TOPIC,
  PREVIEW_INSTANCE_KEY,
  PREVIEW_READY_TOPIC,
  PREVIEW_VIEW_ID,
  selectionPayload,
  type AssetSelectedPayload,
} from './preview-contract'
import { PARAMETERS_PANEL_ID } from './parameters-contract'

type ThemeName = 'dark' | 'light' | 'high-contrast'

const CLASS_LABELS = new Map(
  CATEGORY_OPTIONS.filter((option) => option.value).map((option) => [option.value, option.label]),
)
const numberFormat = new Intl.NumberFormat()

const app = getElement<HTMLDivElement>('app')
const filtersForm = getElement<HTMLFormElement>('filters')
const searchInput = getElement<HTMLInputElement>('search')
const categorySelect = getElement<HTMLSelectElement>('category')
const kitSelect = getElement<HTMLSelectElement>('kit')
const statusLine = getElement<HTMLParagraphElement>('status')
const noteLine = getElement<HTMLParagraphElement>('note')
const resultsArea = getElement<HTMLElement>('results')
const grid = getElement<HTMLDivElement>('grid')
const emptyState = getElement<HTMLDivElement>('empty')
const emptyMessage = getElement<HTMLParagraphElement>('empty-message')
const clearButton = getElement<HTMLButtonElement>('clear')
const errorBanner = getElement<HTMLDivElement>('error')
const errorMessage = getElement<HTMLSpanElement>('error-message')
const retryButton = getElement<HTMLButtonElement>('retry')
const previousButton = getElement<HTMLButtonElement>('prev')
const nextButton = getElement<HTMLButtonElement>('next')
const pageInfo = getElement<HTMLSpanElement>('page-info')
const thumbnailCanvas = getElement<HTMLCanvasElement>('thumbnail-canvas')

const thumbnails = new ThumbnailService(thumbnailCanvas)

interface ViewState {
  filters: AssetFilters
  page: number
  data: AssetPage | null
  kits: PolyforkKit[]
  kitNames: Map<string, string>
  loading: boolean
  error: string | null
}

const state: ViewState = {
  filters: { query: '', category: '', kit: '' },
  page: 1,
  data: null,
  kits: [],
  kitNames: new Map(),
  loading: false,
  error: null,
}

let disposed = false
let loadSequence = 0
let activeController: AbortController | null = null
let searchTimer: number | undefined
const objectUrls = new Set<string>()

let viewClient: ViewClient | null = null
let latestSelection: AssetSelectedPayload | null = null
let selectedAssetId: string | null = null
let previewNote: string | null = null

async function boot(): Promise<void> {
  const connection = await connectBrowserPlugin()
  if (connection.mode !== 'view') {
    throw new Error('This page must be mounted as an Exo panel.')
  }
  const view = connection.view
  viewClient = view

  applyTheme(view.initialization.theme)
  document.title = `${view.view.title} — Polyfork`

  await thumbnails.init()
  document.body.dataset.cache = thumbnails.storageMode

  view.onDispose(() => {
    disposed = true
    activeController?.abort()
    if (searchTimer !== undefined) window.clearTimeout(searchTimer)
    thumbnails.dispose()
    revokeObjectUrls()
  })

  view.onError((error) => {
    console.warn('[polyfork] shell error', error)
  })

  if (view.initialization.permissions.includes('events:subscribe')) {
    void view.subscribe('theme/changed').catch((error: unknown) => {
      console.info('[polyfork] theme changes are not available', error)
    })
    view.onEvent('theme/changed', (event) => {
      if (isThemeName(event.payload.theme)) applyTheme(event.payload.theme)
    })
  }

  void joinPreviewChannel(view)

  populateCategoryOptions()
  kitSelect.disabled = true
  bindEvents()
  renderSkeletons()
  app.dataset.phase = 'ready'

  void loadKits()
  void loadAssets()
}

function renderSkeletons(count = 6): void {
  grid.replaceChildren()
  for (let index = 0; index < count; index += 1) {
    const card = document.createElement('div')
    card.className = 'asset-card is-skeleton'

    const thumb = document.createElement('div')
    thumb.className = 'asset-thumb'

    const body = document.createElement('div')
    body.className = 'asset-body'

    const title = document.createElement('span')
    title.className = 'skeleton-line w-80'

    const id = document.createElement('span')
    id.className = 'skeleton-line w-55'

    body.append(title, id)
    card.append(thumb, body)
    grid.append(card)
  }
}

function bindEvents(): void {
  filtersForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (searchTimer !== undefined) {
      window.clearTimeout(searchTimer)
      searchTimer = undefined
    }
    state.page = 1
    void loadAssets()
  })

  searchInput.addEventListener('input', () => {
    if (searchTimer !== undefined) window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => {
      searchTimer = undefined
      state.page = 1
      void loadAssets()
    }, 300)
  })

  searchInput.addEventListener('search', () => {
    if (searchTimer !== undefined) {
      window.clearTimeout(searchTimer)
      searchTimer = undefined
    }
    state.page = 1
    void loadAssets()
  })

  categorySelect.addEventListener('change', () => {
    state.page = 1
    void loadAssets()
  })

  kitSelect.addEventListener('change', () => {
    state.page = 1
    void loadAssets()
  })

  previousButton.addEventListener('click', () => {
    if (previousButton.disabled) return
    state.page = Math.max(1, state.page - 1)
    resultsArea.scrollTop = 0
    void loadAssets()
  })

  nextButton.addEventListener('click', () => {
    if (nextButton.disabled) return
    state.page += 1
    resultsArea.scrollTop = 0
    void loadAssets()
  })

  retryButton.addEventListener('click', () => {
    void loadAssets()
  })

  clearButton.addEventListener('click', () => {
    searchInput.value = ''
    categorySelect.value = ''
    kitSelect.value = ''
    state.page = 1
    searchInput.focus()
    void loadAssets()
  })
}

async function joinPreviewChannel(view: ViewClient): Promise<void> {
  if (
    !view.capabilities.localEvents ||
    !view.initialization.permissions.includes('events:subscribe')
  ) {
    return
  }

  try {
    await view.subscribeLocal(PREVIEW_READY_TOPIC)
    view.onLocalEvent(PREVIEW_READY_TOPIC, () => {
      publishSelection()
    })
    await view.subscribeLocal(PREVIEW_CLOSED_TOPIC)
    view.onLocalEvent(PREVIEW_CLOSED_TOPIC, () => {
      void hideParametersPanel(view)
    })
  } catch (error) {
    console.warn('[polyfork] preview selection channel is unavailable', error)
  }
}

function selectAsset(asset: PolyforkAsset): void {
  if (disposed) return

  latestSelection = selectionPayload(asset)
  selectedAssetId = asset.id
  previewNote = null
  syncSelection()
  updateStatus()
  void openPreview(latestSelection)
}

async function openPreview(selection: AssetSelectedPayload): Promise<void> {
  const client = viewClient
  if (!client || disposed) return

  try {
    await client.openView({
      viewId: PREVIEW_VIEW_ID,
      instanceKey: PREVIEW_INSTANCE_KEY,
      payload: selection,
    })
    if (disposed) return
    await showParametersPanel(client)
    if (disposed) return
    previewNote = null
    publishSelection()
    updateStatus()
  } catch (error) {
    if (disposed) return
    previewNote = previewMessageFor(error)
    updateStatus()
    console.warn('[polyfork] could not open the asset preview', error)
  }
}

/**
 * The Asset Preview and its parameter editor are one experience: opening the
 * preview reveals the secondary (right side bar) panel as well. Older shells
 * report `unsupported-message`; the preview itself still works.
 */
async function showParametersPanel(client: ViewClient): Promise<void> {
  if (!client.capabilities.requestPanel) return
  try {
    await client.requestPanel(PARAMETERS_PANEL_ID, 'show')
  } catch (error) {
    console.info('[polyfork] the parameter panel could not be shown', error)
  }
}

async function hideParametersPanel(client: ViewClient): Promise<void> {
  if (!client.capabilities.requestPanel) return
  try {
    await client.requestPanel(PARAMETERS_PANEL_ID, 'hide')
  } catch (error) {
    console.info('[polyfork] the parameter panel could not be hidden', error)
  }
}

function publishSelection(): void {
  const client = viewClient
  if (!client || !latestSelection || disposed || !client.capabilities.localEvents) return

  void client.publishLocal(ASSET_SELECTED_TOPIC, latestSelection).catch((error: unknown) => {
    console.warn('[polyfork] preview selection publish failed', error)
  })
}

function previewMessageFor(error: unknown): string {
  if (error instanceof ExoProtocolError) {
    switch (error.code) {
      case 'unsupported-message':
        return 'This Exo version cannot open content views.'
      case 'rate-limited':
        return 'Too many preview requests. Wait a moment and try again.'
      case 'not-found':
        return 'The Asset Preview view is not registered.'
      case 'permission-denied':
        return 'Exo refused to open the preview because the panel is not active.'
    }
  }
  return 'Could not open the asset preview.'
}

function syncSelection(): void {
  for (const card of grid.querySelectorAll<HTMLElement>('.asset-card')) {
    const selected = card.dataset.assetId === selectedAssetId
    card.classList.toggle('is-selected', selected)
    if (selected) card.setAttribute('aria-current', 'true')
    else card.removeAttribute('aria-current')
  }
}

function populateCategoryOptions(): void {
  for (const option of CATEGORY_OPTIONS) {
    categorySelect.append(new Option(option.label, option.value))
  }
}

async function loadKits(): Promise<void> {
  try {
    const kits = await fetchKits()
    if (disposed) return

    state.kits = kits
    state.kitNames = new Map(kits.map((kit) => [kit.id, kit.title]))

    const selected = kitSelect.value
    kitSelect.replaceChildren(new Option('All kits', ''))
    for (const kit of kits) {
      const option = new Option(kit.title, kit.id)
      option.title = `${kit.title} · ${kit.partsPublished}/${kit.partsPlanned} parts`
      kitSelect.append(option)
    }
    kitSelect.value = selected
    kitSelect.disabled = false
    kitSelect.title = 'Filter by Polyfork kit'
    updateKitLabels()
  } catch (error) {
    if (disposed) return
    console.warn('[polyfork] kit list failed', error)
    kitSelect.title = 'The Polyfork kit list could not be loaded.'
  }
}

async function loadAssets(): Promise<void> {
  if (disposed) return

  activeController?.abort()
  const controller = new AbortController()
  activeController = controller

  const sequence = ++loadSequence
  const filters = currentFilters()
  state.filters = filters
  state.loading = true
  state.error = null
  hideError()
  updateChrome()

  const generation = thumbnails.beginPage()

  try {
    const data = await fetchAssets(filters, state.page, controller.signal)
    if (disposed || sequence !== loadSequence) return

    state.data = data
    state.page = data.page
    renderResults(data, generation)
  } catch (error) {
    if (disposed || sequence !== loadSequence || controller.signal.aborted) return
    state.error = userMessageFor(error)
    if (!state.data) {
      grid.replaceChildren()
      emptyState.hidden = true
    }
    showError(state.error)
  } finally {
    if (!disposed && sequence === loadSequence) {
      state.loading = false
      updateChrome()
    }
  }
}

function renderResults(data: AssetPage, generation: number): void {
  revokeObjectUrls()
  grid.replaceChildren()

  const isEmpty = data.assets.length === 0
  grid.classList.toggle('is-single', data.exact && data.assets.length === 1)
  emptyState.hidden = !isEmpty
  clearButton.hidden = !hasActiveFilters()

  if (isEmpty) {
    emptyMessage.textContent = emptyMessageFor(data)
    return
  }

  const fragment = document.createDocumentFragment()
  for (const asset of data.assets) {
    fragment.append(createAssetCard(asset, generation))
  }
  grid.append(fragment)
  syncSelection()
}

function createAssetCard(asset: PolyforkAsset, generation: number): HTMLElement {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'asset-card'
  card.dataset.assetId = asset.id
  card.dataset.class = asset.class
  card.dataset.kit = asset.kit ?? ''
  card.title = `${asset.title} — ${asset.id}`
  card.setAttribute('aria-label', `Preview ${asset.title} (${asset.id})`)
  card.addEventListener('click', () => selectAsset(asset))

  const thumb = document.createElement('span')
  thumb.className = 'asset-thumb'

  if (asset.thumbnail) {
    let fallbackStarted = false
    const image = document.createElement('img')
    image.alt = ''
    image.loading = 'lazy'
    image.decoding = 'async'
    image.referrerPolicy = 'no-referrer'
    image.className = 'thumb-image'
    image.dataset.source = 'polyfork'
    image.addEventListener('load', () => image.classList.add('is-loaded'), { once: true })
    image.addEventListener(
      'error',
      () => {
        if (fallbackStarted) return
        fallbackStarted = true
        image.remove()
        if (card.isConnected) renderFallbackThumbnail(thumb, card, asset, generation)
      },
      { once: true },
    )
    image.src = asset.thumbnail
    thumb.append(image)
  } else {
    renderFallbackThumbnail(thumb, card, asset, generation)
  }

  const previewHint = document.createElement('span')
  previewHint.className = 'asset-open-hint'
  previewHint.textContent = 'Preview'
  previewHint.setAttribute('aria-hidden', 'true')
  thumb.append(previewHint)

  const body = document.createElement('span')
  body.className = 'asset-body'

  const title = document.createElement('span')
  title.className = 'asset-title'
  title.textContent = asset.title
  title.title = asset.title

  const id = document.createElement('code')
  id.className = 'asset-id'
  id.textContent = asset.id
  id.title = asset.id

  const meta = document.createElement('span')
  meta.className = 'asset-meta'
  meta.append(chip(classLabel(asset.class)))
  meta.append(chip(`${formatTriangles(asset.triangles)} tris`))
  if (asset.hasSkeleton) meta.append(chip('Animated'))
  else if (asset.hasRig) meta.append(chip('Rigged'))

  body.append(title, id, meta)

  if (asset.kit) {
    const kit = document.createElement('span')
    kit.className = 'asset-kit'
    kit.dataset.kitId = asset.kit
    kit.textContent = kitName(asset.kit)
    kit.title = `Kit: ${kitName(asset.kit)} (${asset.kit})`
    body.append(kit)
  }

  card.append(thumb, body)
  return card
}

function renderFallbackThumbnail(
  thumb: HTMLElement,
  card: HTMLElement,
  asset: PolyforkAsset,
  generation: number,
): void {
  const placeholder = document.createElement('div')
  placeholder.className = 'thumb-placeholder'
  placeholder.textContent = '3D'
  placeholder.title = 'Rendering from the Polyfork three.js module'
  thumb.append(placeholder)
  card.classList.add('is-rendering')

  thumbnails.ensure(asset, generation, (blob) => {
    if (disposed || !card.isConnected) return
    card.classList.remove('is-rendering')

    if (!blob) {
      card.classList.add('thumb-failed')
      placeholder.textContent = 'No preview'
      return
    }

    placeholder.remove()
    const image = document.createElement('img')
    image.alt = ''
    image.className = 'thumb-image thumb-rendered is-loaded'
    image.dataset.source = 'rendered'
    const url = URL.createObjectURL(blob)
    objectUrls.add(url)
    image.src = url

    const badge = document.createElement('span')
    badge.className = 'thumb-badge'
    badge.textContent = '3D'
    badge.title = 'Rendered from the Polyfork three.js module'

    thumb.append(image, badge)
  })
}

function updateChrome(): void {
  app.classList.toggle('is-loading', state.loading)
  app.setAttribute('aria-busy', String(state.loading))
  updateStatus()
  updatePager()
}

function updateStatus(): void {
  if (state.loading) {
    statusLine.textContent = state.data ? 'Loading…' : 'Loading assets…'
    noteLine.hidden = true
    return
  }

  if (state.error) {
    statusLine.textContent = state.data ? 'Could not refresh' : 'Could not load assets'
    noteLine.hidden = true
    return
  }

  const data = state.data
  if (!data) {
    statusLine.textContent = 'Ready'
    noteLine.hidden = true
    return
  }

  if (data.total === 0) {
    statusLine.textContent = '0 assets'
  } else if (data.exact) {
    statusLine.textContent = 'Exact ID match'
  } else {
    const bounds = pageBounds(data.page, data.total, data.perPage)
    statusLine.textContent = `${numberFormat.format(data.total)} ${
      data.total === 1 ? 'asset' : 'assets'
    } · ${numberFormat.format(bounds.start)}–${numberFormat.format(bounds.end)}`
  }

  const note = previewNote ?? noteFor(data)
  noteLine.textContent = note ?? ''
  noteLine.hidden = !note
}

function updatePager(): void {
  const data = state.data
  const total = data?.total ?? 0
  const perPage = data?.perPage ?? PAGE_SIZE
  const pages = totalPages(total, perPage)
  const page = data?.page ?? state.page
  const hasResults = data !== null && total > 0

  pageInfo.textContent = hasResults ? `Page ${page} of ${pages}` : 'Page 1 of 1'
  previousButton.disabled = state.loading || !hasResults || page <= 1
  nextButton.disabled = state.loading || !hasResults || page >= pages
}

function noteFor(data: AssetPage): string | null {
  if (data.filteredExact) {
    return `“${data.exactAsset?.title ?? state.filters.query}” is excluded by the current category or kit filter.`
  }
  if (data.exactMiss) {
    return 'No exact id match; showing name results.'
  }
  if (data.coverage === 'poor') {
    if (data.unmatchedTerms.length > 0) {
      return `Loose name match; ignored ${data.unmatchedTerms.join(', ')}.`
    }
    return 'Loose name match; showing the closest results.'
  }
  if (data.coverage === 'filtered_out') {
    return 'Matches exist, but the current filters hide them.'
  }
  if (data.unmatchedTerms.length > 0) {
    return `Ignored search terms: ${data.unmatchedTerms.join(', ')}.`
  }
  return null
}

function emptyMessageFor(data: AssetPage): string {
  if (data.filteredExact) {
    return 'The exact asset is hidden by the selected category or kit.'
  }
  const query = state.filters.query.trim()
  if (query) return `No assets match “${query}”.`
  if (state.filters.category || state.filters.kit) {
    return 'No assets match the selected category and kit.'
  }
  return 'Polyfork returned no assets.'
}

function currentFilters(): AssetFilters {
  return {
    query: searchInput.value,
    category: categorySelect.value,
    kit: kitSelect.value,
  }
}

function hasActiveFilters(): boolean {
  return Boolean(searchInput.value.trim() || categorySelect.value || kitSelect.value)
}

function kitName(id: string): string {
  return state.kitNames.get(id) ?? id
}

function updateKitLabels(): void {
  for (const element of grid.querySelectorAll<HTMLElement>('[data-kit-id]')) {
    const id = element.dataset.kitId ?? ''
    element.textContent = kitName(id)
    element.title = `Kit: ${kitName(id)} (${id})`
  }
}

function showError(message: string): void {
  errorMessage.textContent = message
  errorBanner.hidden = false
}

function hideError(): void {
  errorBanner.hidden = true
}

function userMessageFor(error: unknown): string {
  if (error instanceof PolyforkError) {
    switch (error.kind) {
      case 'timeout':
        return 'Polyfork did not respond. Try again.'
      case 'network':
        return 'Could not reach polyfork.dev. Check your connection.'
      case 'invalid':
        return 'Polyfork returned an unexpected response.'
      case 'http':
        if (error.status === 429) {
          return 'Polyfork is rate-limiting requests. Wait a moment and retry.'
        }
        if (error.status !== undefined && error.status >= 500) {
          return 'Polyfork is having trouble right now. Retry in a moment.'
        }
        return `Polyfork answered ${error.status ?? 'with an error'}.`
    }
  }
  return 'Could not load assets.'
}

function revokeObjectUrls(): void {
  for (const url of objectUrls) URL.revokeObjectURL(url)
  objectUrls.clear()
}

function classLabel(value: string): string {
  if (!value) return 'Asset'
  return CLASS_LABELS.get(value) ?? value.charAt(0).toUpperCase() + value.slice(1)
}

function formatTriangles(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 10_000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function chip(text: string): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = 'chip'
  element.textContent = text
  return element
}

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
}

function isThemeName(value: unknown): value is ThemeName {
  return value === 'dark' || value === 'light' || value === 'high-contrast'
}

function showBootError(error: unknown): void {
  app.dataset.phase = 'error'
  app.hidden = true
  const box = document.getElementById('boot-error')
  const detail = document.getElementById('boot-error-detail')
  if (box) box.hidden = false
  if (detail) detail.textContent = error instanceof Error ? error.message : String(error)
  console.error('[polyfork] boot failed', error)
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`The Polyfork panel is missing #${id}.`)
  return element as T
}

void boot().catch(showBootError)

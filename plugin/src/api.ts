export const POLYFORK_ORIGIN = 'https://polyfork.dev'
export const PAGE_SIZE = 20

const API_BASE = `${POLYFORK_ORIGIN}/api`
const REQUEST_TIMEOUT_MS = 15_000
const SAFE_ASSET_ID = /^[a-z0-9][a-z0-9-]{1,127}$/
/**
 * Polyfork asset ids are lowercase slugs ending in a six-character hash, or in
 * `-base` for the character base meshes. Requiring that shape means a normal
 * name search never pays for a detail request.
 */
const EXACT_ASSET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*-(?:[0-9a-f]{6}|base)$/

export interface PolyforkAsset {
  id: string
  title: string
  class: string
  kit: string | null
  triangles: number
  thumbnail: string | null
  free: boolean
  hasRig: boolean
  hasSkeleton: boolean
  remixable: boolean
}

export interface PolyforkKit {
  id: string
  title: string
  status: string
  partsPublished: number
  partsPlanned: number
}

export interface AssetFilters {
  query: string
  category: string
  kit: string
}

export interface AssetPage {
  assets: PolyforkAsset[]
  total: number
  page: number
  perPage: number
  coverage?: 'none' | 'poor' | 'ok' | 'filtered_out'
  unmatchedTerms: string[]
  exact: boolean
  exactAsset?: PolyforkAsset
  filteredExact: boolean
  exactMiss: boolean
}

export const CATEGORY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All categories' },
  { value: 'prop', label: 'Props' },
  { value: 'building', label: 'Buildings' },
  { value: 'vehicle', label: 'Vehicles' },
  { value: 'character', label: 'Characters' },
  { value: 'animal', label: 'Animals' },
  { value: 'ultra', label: 'Nano' },
  { value: 'attachment', label: 'Attachments' },
  { value: 'terrain', label: 'Terrain' },
  { value: 'hand', label: 'Hands' },
]

export class PolyforkError extends Error {
  readonly kind: 'http' | 'network' | 'timeout' | 'invalid'
  readonly status?: number

  constructor(kind: PolyforkError['kind'], message: string, status?: number) {
    super(message)
    this.name = 'PolyforkError'
    this.kind = kind
    this.status = status
  }
}

export function isSafeAssetId(value: string): boolean {
  return SAFE_ASSET_ID.test(value)
}

export function normalizeAssetId(value: string): string | null {
  const candidate = value.trim().toLowerCase()
  return EXACT_ASSET_ID.test(candidate) ? candidate : null
}

export function buildAssetsUrl(filters: AssetFilters, page: number): string {
  const params = new URLSearchParams()
  params.set('free', '1')
  params.set('per_page', String(PAGE_SIZE))
  params.set('page', String(Math.max(1, Math.trunc(page) || 1)))

  const query = filters.query.trim()
  if (query) params.set('q', query)
  if (filters.category) params.set('class', filters.category)
  if (filters.kit) params.set('kit', filters.kit)

  return `${API_BASE}/assets?${params.toString()}`
}

export function buildKitsUrl(): string {
  return `${API_BASE}/kits`
}

export function totalPages(total: number, perPage = PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1
  return Math.max(1, Math.ceil(total / Math.max(1, perPage)))
}

export function pageBounds(
  page: number,
  total: number,
  perPage = PAGE_SIZE,
): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 }
  const safePage = Math.max(1, Math.min(page, totalPages(total, perPage)))
  const start = (safePage - 1) * perPage + 1
  return { start, end: Math.min(safePage * perPage, total) }
}

export function assetMatchesFilters(asset: PolyforkAsset, filters: AssetFilters): boolean {
  if (filters.category && asset.class !== filters.category) return false
  if (filters.kit && asset.kit !== filters.kit) return false
  return true
}

export async function fetchAssets(
  filters: AssetFilters,
  page: number,
  signal?: AbortSignal,
): Promise<AssetPage> {
  const exactId = normalizeAssetId(filters.query)
  let exactMiss = false

  if (exactId) {
    // The catalogue search scores names and kit text; it does not match ids.
    // A full id is resolved through the detail endpoint instead.
    const detail = await requestJson(`${API_BASE}/assets/${exactId}`, signal)
    if (detail.status === 200) {
      const asset = parseAsset(detail.data)
      if (!asset) {
        throw new PolyforkError('invalid', 'Polyfork returned an unexpected asset record.')
      }
      const allowed = assetMatchesFilters(asset, filters)
      return {
        assets: allowed ? [asset] : [],
        total: allowed ? 1 : 0,
        page: 1,
        perPage: PAGE_SIZE,
        unmatchedTerms: [],
        exact: true,
        exactAsset: asset,
        filteredExact: !allowed,
        exactMiss: false,
      }
    }
    if (detail.status !== 404) {
      throw new PolyforkError(
        'http',
        `Polyfork answered ${detail.status} for the asset id.`,
        detail.status,
      )
    }
    exactMiss = true
  }

  const result = await requestJson(buildAssetsUrl(filters, page), signal)
  if (result.status !== 200) {
    throw new PolyforkError('http', `Polyfork answered ${result.status}.`, result.status)
  }

  return {
    ...parseAssetPage(result.data),
    exact: false,
    exactMiss,
    filteredExact: false,
  }
}

export async function fetchKits(signal?: AbortSignal): Promise<PolyforkKit[]> {
  const result = await requestJson(buildKitsUrl(), signal)
  if (result.status !== 200) {
    throw new PolyforkError('http', `Polyfork answered ${result.status}.`, result.status)
  }
  const record = asRecord(result.data)
  if (!record || !Array.isArray(record.kits)) {
    throw new PolyforkError('invalid', 'Polyfork returned an unexpected kit list.')
  }

  const kits: PolyforkKit[] = []
  for (const item of record.kits) {
    const kit = asRecord(item)
    if (!kit) continue
    const id = typeof kit.id === 'string' ? kit.id : ''
    const title = typeof kit.title === 'string' ? kit.title.trim() : ''
    if (!isSafeAssetId(id) || !title) continue
    kits.push({
      id,
      title,
      status: typeof kit.status === 'string' ? kit.status : '',
      partsPublished: numberOr(kit.parts_published, 0),
      partsPlanned: numberOr(kit.parts_planned, 0),
    })
  }

  return kits.sort((a, b) => a.title.localeCompare(b.title))
}

export function parseAsset(value: unknown): PolyforkAsset | null {
  const record = asRecord(value)
  if (!record) return null
  const id = typeof record.id === 'string' ? record.id : ''
  if (!isSafeAssetId(id)) return null

  return {
    id,
    title: typeof record.title === 'string' && record.title.trim() ? record.title : id,
    class: typeof record.class === 'string' && record.class ? record.class : 'unknown',
    kit: typeof record.kit === 'string' && isSafeAssetId(record.kit) ? record.kit : null,
    triangles: Math.max(0, Math.trunc(numberOr(record.triangles, 0))),
    thumbnail: parseThumbnail(record.thumbnail),
    free: record.free === true,
    // The parser also accepts its own normalized snapshot, which is what the
    // panel sends to the preview content view.
    hasRig: record.has_rig === true || record.hasRig === true,
    hasSkeleton: record.has_skeleton === true || record.hasSkeleton === true,
    remixable: record.remixable === true,
  }
}

function parseAssetPage(value: unknown): Omit<AssetPage, 'exact' | 'exactAsset' | 'filteredExact' | 'exactMiss'> {
  const record = asRecord(value)
  if (!record || !Array.isArray(record.assets)) {
    throw new PolyforkError('invalid', 'Polyfork returned an unexpected asset list.')
  }

  const assets: PolyforkAsset[] = []
  for (const item of record.assets) {
    const asset = parseAsset(item)
    if (asset) assets.push(asset)
  }

  const coverage = record.coverage
  return {
    assets,
    total: Math.max(0, Math.trunc(numberOr(record.total, assets.length))),
    page: Math.max(1, Math.trunc(numberOr(record.page, 1))),
    perPage: Math.max(1, Math.trunc(numberOr(record.per_page, PAGE_SIZE))),
    ...(coverage === 'none' ||
    coverage === 'poor' ||
    coverage === 'ok' ||
    coverage === 'filtered_out'
      ? { coverage }
      : {}),
    unmatchedTerms: Array.isArray(record.unmatched_terms)
      ? record.unmatched_terms.filter((term): term is string => typeof term === 'string')
      : [],
  }
}

function parseThumbnail(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    if (url.hostname !== 'polyfork.dev' && !url.hostname.endsWith('.polyfork.dev')) return null
    return url.toString()
  } catch {
    return null
  }
}

interface JsonResult {
  status: number
  data: unknown
}

async function requestJson(url: string, signal?: AbortSignal): Promise<JsonResult> {
  const controller = new AbortController()
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'default',
      headers: { accept: 'application/json' },
      referrerPolicy: 'no-referrer',
    })

    if (response.status === 404) return { status: 404, data: null }
    if (!response.ok) {
      throw new PolyforkError('http', `Polyfork answered ${response.status}.`, response.status)
    }

    let data: unknown
    try {
      data = await response.json()
    } catch {
      throw new PolyforkError('invalid', 'Polyfork returned invalid JSON.')
    }
    return { status: response.status, data }
  } catch (error) {
    if (error instanceof PolyforkError) throw error
    if (signal?.aborted) throw error
    if (timedOut) throw new PolyforkError('timeout', 'Polyfork did not respond in time.')
    throw new PolyforkError('network', 'Could not reach polyfork.dev.')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

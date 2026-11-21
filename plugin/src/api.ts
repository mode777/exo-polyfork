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

export type AssetParamValue = string | number | boolean

export interface AssetParamDefinition {
  key: string
  type: 'color' | 'range' | 'choice' | 'toggle'
  label: string
  describe: string
  default: AssetParamValue
  options?: string[]
  min?: number
  max?: number
  step?: number
}

export interface AssetParamsSchema {
  params: AssetParamDefinition[]
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

export function buildAssetParamsUrl(assetId: string): string {
  return `${POLYFORK_ORIGIN}/cdn/${assetId}-params.json`
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

/**
 * Fetch the public `-params.json` schema for a remixable asset. The CDN answers
 * 404 for assets without knobs, which is a normal "no parameters" result.
 */
export async function fetchAssetParams(
  assetId: string,
  signal?: AbortSignal,
): Promise<AssetParamsSchema | null> {
  if (!isSafeAssetId(assetId)) throw new PolyforkError('invalid', 'Invalid asset id.')
  const result = await requestJson(buildAssetParamsUrl(assetId), signal)
  if (result.status === 404) return null
  const schema = parseAssetParams(result.data)
  if (!schema) {
    throw new PolyforkError('invalid', 'Polyfork returned an unexpected parameter schema.')
  }
  return schema
}

const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const MAX_PARAMS = 64
const MAX_PARAM_OPTIONS = 64
const HEX_COLOR = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i

export function parseAssetParams(value: unknown): AssetParamsSchema | null {
  const record = asRecord(value)
  if (!record) return null
  const params = Array.isArray(record.params)
    ? parseParamDefinitions(record.params)
    : parseParamMap(record.params)
  return params ? { params } : null
}

/** The CDN file keys its knobs by name; preserve that published order. */
function parseParamMap(value: unknown): AssetParamDefinition[] | null {
  const record = asRecord(value)
  if (!record) return null
  const entries = Object.entries(record)
  if (entries.length > MAX_PARAMS) return null

  const definitions: AssetParamDefinition[] = []
  for (const [key, item] of entries) {
    if (!PARAM_KEY.test(key)) return null
    const knobs = asRecord(item)
    if (!knobs) return null
    const label =
      typeof knobs.label === 'string' && knobs.label.trim() ? knobs.label.trim() : key
    const describe = typeof knobs.describe === 'string' ? knobs.describe : ''
    const definition = parseParamDefinition(key, label, describe, knobs)
    if (definition) definitions.push(definition)
  }
  return definitions
}

/** Validate the schema array used both on the wire and by the controls. */
export function parseParamDefinitions(value: unknown): AssetParamDefinition[] | null {
  if (!Array.isArray(value) || value.length > MAX_PARAMS) return null
  const definitions: AssetParamDefinition[] = []
  const seen = new Set<string>()

  for (const item of value) {
    const record = asRecord(item)
    if (!record) return null
    const key = typeof record.key === 'string' ? record.key : ''
    if (!PARAM_KEY.test(key) || seen.has(key)) return null
    seen.add(key)

    const label =
      typeof record.label === 'string' && record.label.trim() ? record.label.trim() : key
    const describe = typeof record.describe === 'string' ? record.describe : ''
    const definition = parseParamDefinition(key, label, describe, record)
    if (definition) definitions.push(definition)
  }

  return definitions
}

function parseParamDefinition(
  key: string,
  label: string,
  describe: string,
  record: Record<string, unknown>,
): AssetParamDefinition | null {
  if (record.type === 'color') {
    if (typeof record.default !== 'string' || !HEX_COLOR.test(record.default)) return null
    return { key, type: 'color', label, describe, default: record.default.toLowerCase() }
  }

  if (record.type === 'range') {
    const min = numberOrNull(record.min)
    const max = numberOrNull(record.max)
    const fallback = numberOrNull(record.default)
    if (min === null || max === null || fallback === null || min > max) return null
    const step = numberOrNull(record.step)
    return {
      key,
      type: 'range',
      label,
      describe,
      default: clampNumber(fallback, min, max),
      min,
      max,
      ...(step !== null && step > 0 ? { step } : {}),
    }
  }

  if (record.type === 'choice') {
    if (!Array.isArray(record.options) || record.options.length === 0) return null
    if (record.options.length > MAX_PARAM_OPTIONS) return null
    if (record.options.some((option) => typeof option !== 'string' || !option)) return null
    const options = record.options as string[]
    const fallback =
      typeof record.default === 'string' && options.includes(record.default)
        ? record.default
        : options[0]
    return { key, type: 'choice', label, describe, default: fallback, options }
  }

  if (record.type === 'toggle') {
    if (typeof record.default !== 'boolean') return null
    return { key, type: 'toggle', label, describe, default: record.default }
  }

  return null
}

export function defaultParamValues(schema: AssetParamsSchema): Record<string, AssetParamValue> {
  const values: Record<string, AssetParamValue> = {}
  for (const definition of schema.params) values[definition.key] = definition.default
  return values
}

/** Accept only values that match the schema; unknown keys and types are dropped. */
export function sanitizeParamValues(
  schema: AssetParamsSchema,
  value: unknown,
): Record<string, AssetParamValue> {
  const record = asRecord(value)
  if (!record) return {}
  const values: Record<string, AssetParamValue> = {}

  for (const definition of schema.params) {
    const candidate = record[definition.key]
    if (candidate === undefined) continue
    const sanitized = sanitizeParamValue(definition, candidate)
    if (sanitized !== null) values[definition.key] = sanitized
  }

  return values
}

function sanitizeParamValue(
  definition: AssetParamDefinition,
  value: unknown,
): AssetParamValue | null {
  if (definition.type === 'color') {
    return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : null
  }
  if (definition.type === 'range') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    return clampNumber(value, definition.min ?? value, definition.max ?? value)
  }
  if (definition.type === 'choice') {
    return typeof value === 'string' && definition.options?.includes(value) ? value : null
  }
  return typeof value === 'boolean' ? value : null
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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

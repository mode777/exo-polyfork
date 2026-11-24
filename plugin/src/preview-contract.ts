import { isSafeAssetId, parseAsset, type PolyforkAsset } from './api'

/**
 * The asset-preview content view and the payload both frames agree on. Each
 * asset opens its own content-view instance; the first payload arrives in
 * `shell/init`, and later parameter traffic is scoped by the view's instance
 * id. The manifest's `companionPanel` makes the shell reveal the Parameters
 * panel whenever a preview tab is active.
 */
export const PREVIEW_VIEW_ID = 'asset-preview'
export const PREVIEW_PAYLOAD_VERSION = 1

export interface AssetSelectedPayload {
  version: typeof PREVIEW_PAYLOAD_VERSION
  asset: PolyforkAsset
}

export function selectionPayload(asset: PolyforkAsset): AssetSelectedPayload {
  return { version: PREVIEW_PAYLOAD_VERSION, asset: { ...asset } }
}

/** Validate a content-view payload or local-event body; never trust either. */
export function parseSelectionPayload(value: unknown): AssetSelectedPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== PREVIEW_PAYLOAD_VERSION) return null
  const asset = parseAsset(record.asset)
  return asset ? { version: PREVIEW_PAYLOAD_VERSION, asset } : null
}

/**
 * One tab per asset. The key is stable across panel reloads and short enough
 * for the shell's 64-character instance limit, even though a valid Polyfork id
 * may be longer. Two FNV-1a lanes keep the generated key collision-safe.
 */
export function previewInstanceKey(assetId: string): string {
  if (!isSafeAssetId(assetId)) throw new Error('Invalid asset id.')
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < assetId.length; index += 1) {
    const code = assetId.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  const hash =
    (first >>> 0).toString(16).padStart(8, '0') +
    (second >>> 0).toString(16).padStart(8, '0')
  return `preview-${hash}`
}

export function isPreviewInstanceKey(value: string): boolean {
  return /^preview-[0-9a-f]{16}$/.test(value)
}

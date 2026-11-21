import { parseAsset, type PolyforkAsset } from './api'

/**
 * The asset-preview content view and the payload both frames agree on. The
 * shell delivers `payload` once, when the tab is created; later selections are
 * pushed over the plugin-local topic while the one preview tab stays open.
 */
export const PREVIEW_VIEW_ID = 'asset-preview'
export const PREVIEW_INSTANCE_KEY = 'preview'
export const ASSET_SELECTED_TOPIC = 'local/asset-selected'
export const PREVIEW_READY_TOPIC = 'local/preview-ready'
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

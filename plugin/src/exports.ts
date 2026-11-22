import {
  buildAssetModuleUrl,
  type AssetParamValue,
  type PolyforkAsset,
} from './api'

export const CONFIG_EXPORT_VERSION = 1

/**
 * The JSON export is a replayable recipe: the Polyfork generator module plus
 * the parameter values that were passed to `createAsset(params)`.
 */
export interface AssetConfigExport {
  schemaVersion: typeof CONFIG_EXPORT_VERSION
  assetId: string
  title: string
  generator: string
  params: Record<string, AssetParamValue>
}

export function buildAssetConfigExport(
  asset: PolyforkAsset,
  params: Record<string, AssetParamValue>,
): AssetConfigExport {
  return {
    schemaVersion: CONFIG_EXPORT_VERSION,
    assetId: asset.id,
    title: asset.title,
    generator: buildAssetModuleUrl(asset.id),
    params: { ...params },
  }
}

export function exportFileName(assetId: string, extension: 'glb' | 'json'): string {
  return `${assetId}.${extension}`
}

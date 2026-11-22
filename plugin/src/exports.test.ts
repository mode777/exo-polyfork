import { describe, expect, it } from 'vitest'
import type { PolyforkAsset } from './api'
import { buildAssetConfigExport, exportFileName } from './exports'

const asset: PolyforkAsset = {
  id: 'stable-57d8b1',
  title: 'Stable',
  class: 'building',
  kit: 'medieval-village-kit-ca0b43',
  triangles: 2907,
  thumbnail: 'https://polyfork.dev/files/stable-57d8b1/renders/hero.png',
  free: true,
  hasRig: true,
  hasSkeleton: false,
  remixable: true,
}

describe('buildAssetConfigExport', () => {
  it('records the parameters and the Polyfork generator module URL', () => {
    expect(buildAssetConfigExport(asset, { faction: 'wei', roofPitch: 0.4 })).toEqual({
      schemaVersion: 1,
      assetId: 'stable-57d8b1',
      title: 'Stable',
      generator: 'https://polyfork.dev/cdn/stable-57d8b1.mjs',
      params: { faction: 'wei', roofPitch: 0.4 },
    })
  })

  it('snapshots the parameter values', () => {
    const params = { faction: 'wei' }
    const exported = buildAssetConfigExport(asset, params)
    params.faction = 'yue'
    expect(exported.params.faction).toBe('wei')
  })

  it('rejects an asset id that cannot address the CDN', () => {
    expect(() =>
      buildAssetConfigExport({ ...asset, id: '../stable-57d8b1' }, {}),
    ).toThrow('Invalid asset id.')
  })
})

describe('exportFileName', () => {
  it('uses the asset id and the requested extension', () => {
    expect(exportFileName('stable-57d8b1', 'glb')).toBe('stable-57d8b1.glb')
    expect(exportFileName('stable-57d8b1', 'json')).toBe('stable-57d8b1.json')
  })
})

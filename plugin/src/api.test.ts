import { describe, expect, it } from 'vitest'
import {
  applyParamPreset,
  buildAssetParamsUrl,
  buildAssetsUrl,
  defaultParamValues,
  normalizeAssetId,
  pageBounds,
  parseAsset,
  parseAssetParams,
  sanitizeParamValues,
  totalPages,
  type PolyforkAsset,
} from './api'

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

describe('buildAssetsUrl', () => {
  it('always asks for free assets, twenty per page', () => {
    expect(buildAssetsUrl({ query: '', category: '', kit: '' }, 1)).toBe(
      'https://polyfork.dev/api/assets?free=1&per_page=20&page=1',
    )
  })

  it('encodes the name, category and kit filters', () => {
    expect(
      buildAssetsUrl(
        { query: '  water pump ', category: 'prop', kit: 'cozy-farm-cc979f' },
        3,
      ),
    ).toBe(
      'https://polyfork.dev/api/assets?free=1&per_page=20&page=3&q=water+pump&class=prop&kit=cozy-farm-cc979f',
    )
  })

  it('clamps an invalid page', () => {
    expect(buildAssetsUrl({ query: '', category: '', kit: '' }, 0)).toContain('page=1')
    expect(buildAssetsUrl({ query: '', category: '', kit: '' }, -4)).toContain('page=1')
  })
})

describe('normalizeAssetId', () => {
  it('accepts the two published id shapes', () => {
    expect(normalizeAssetId('stable-57d8b1')).toBe('stable-57d8b1')
    expect(normalizeAssetId(' general-base ')).toBe('general-base')
    expect(normalizeAssetId('Stable-57D8B1')).toBe('stable-57d8b1')
  })

  it('does not mistake a name for an id', () => {
    expect(normalizeAssetId('stable')).toBeNull()
    expect(normalizeAssetId('water pump')).toBeNull()
    expect(normalizeAssetId('stable-zzzzzz')).toBeNull()
  })
})

describe('pagination', () => {
  it('reports one page for an empty catalogue', () => {
    expect(totalPages(0)).toBe(1)
    expect(totalPages(20)).toBe(1)
    expect(totalPages(21)).toBe(2)
    expect(totalPages(3489)).toBe(175)
  })

  it('formats the visible range', () => {
    expect(pageBounds(1, 0)).toEqual({ start: 0, end: 0 })
    expect(pageBounds(1, 3489)).toEqual({ start: 1, end: 20 })
    expect(pageBounds(2, 3489)).toEqual({ start: 21, end: 40 })
    expect(pageBounds(175, 3489)).toEqual({ start: 3481, end: 3489 })
    expect(pageBounds(999, 3489)).toEqual({ start: 3481, end: 3489 })
  })
})

describe('asset parameter schema', () => {
  const raw = {
    params: {
      faction: {
        type: 'choice',
        default: 'none',
        label: 'Faction',
        describe: 'Kit-wide faction colourway.',
        options: ['none', 'wei'],
      },
      roofPitch: {
        type: 'range',
        default: 27,
        label: 'Roof pitch',
        describe: 'Slope in degrees.',
        affects: 'geometry',
        min: 20,
        max: 36,
        step: 1,
      },
      ridge: { type: 'color', default: '#6D6660', label: 'Ridge', describe: 'Ridge colour.' },
      fire: { type: 'toggle', default: true, label: 'Fire', describe: 'Light the forge.' },
      unsupported: { type: 'texture', default: 'x', label: 'Nope' },
    },
    presets: {
      none: { ridge: '#6d6660' },
      wei: { ridge: '#688795', fire: false },
    },
  }

  it('builds the public parameters URL', () => {
    expect(buildAssetParamsUrl('stable-57d8b1')).toBe(
      'https://polyfork.dev/cdn/stable-57d8b1-params.json',
    )
  })

  it('parses the knobs, rejects unknown types and clamps defaults', () => {
    const schema = parseAssetParams(raw)
    expect(schema?.params.map((param) => [param.key, param.type])).toEqual([
      ['faction', 'choice'],
      ['roofPitch', 'range'],
      ['ridge', 'color'],
      ['fire', 'toggle'],
    ])
    expect(schema?.params[0]).toMatchObject({ default: 'none', options: ['none', 'wei'] })
    expect(schema?.params[1]).toMatchObject({ default: 27, min: 20, max: 36, step: 1 })
    expect(schema?.params[2].default).toBe('#6d6660')
    expect(defaultParamValues(schema!)).toEqual({
      faction: 'none',
      roofPitch: 27,
      ridge: '#6d6660',
      fire: true,
    })
  })

  it('drops unknown keys and invalid values', () => {
    const schema = parseAssetParams(raw)!
    expect(
      sanitizeParamValues(schema, {
        faction: 'wei',
        roofPitch: 999,
        ridge: '#FFF',
        fire: 'yes',
        nope: 1,
      }),
    ).toEqual({ faction: 'wei', roofPitch: 36, ridge: '#fff' })
  })

  it('applies named presets to the knobs they cover', () => {
    const schema = parseAssetParams(raw)!
    expect(schema.presets).toEqual({
      none: { ridge: '#6d6660' },
      wei: { ridge: '#688795', fire: false },
    })
    expect(applyParamPreset(schema, defaultParamValues(schema), 'wei')).toEqual({
      faction: 'none',
      roofPitch: 27,
      ridge: '#688795',
      fire: false,
    })
  })

  it('rejects malformed schemas', () => {
    expect(parseAssetParams(null)).toBeNull()
    expect(parseAssetParams({ params: [] })).toEqual({ params: [], presets: {} })
    expect(parseAssetParams({ params: 'nope' })).toBeNull()
    expect(
      parseAssetParams({ params: { bad: { type: 'range', default: 1, min: 5, max: 2 } } }),
    ).toEqual({ params: [], presets: {} })
  })
})

describe('parseAsset', () => {
  it('maps a catalogue row', () => {
    expect(
      parseAsset({
        id: 'stable-57d8b1',
        title: 'Stable',
        class: 'building',
        kit: 'medieval-village-kit-ca0b43',
        triangles: 2907,
        thumbnail: 'https://polyfork.dev/files/stable-57d8b1/renders/hero.png',
        free: true,
        has_rig: true,
        has_skeleton: false,
        remixable: true,
      }),
    ).toEqual(asset)
  })

  it('rejects unsafe ids and non-Polyfork thumbnail origins', () => {
    expect(parseAsset({ id: '../escape', title: 'No' })).toBeNull()
    expect(
      parseAsset({
        id: 'stable-57d8b1',
        title: 'Stable',
        thumbnail: 'https://evil.example/stable.png',
      })?.thumbnail,
    ).toBeNull()
    expect(
      parseAsset({
        id: 'stable-57d8b1',
        title: 'Stable',
        thumbnail: 'http://polyfork.dev/stable.png',
      })?.thumbnail,
    ).toBeNull()
    expect(
      parseAsset({
        id: 'stable-57d8b1',
        title: 'Stable',
        thumbnail: 'https://cdn.polyfork.dev/stable.png',
      })?.thumbnail,
    ).toBe('https://cdn.polyfork.dev/stable.png')
  })

  it('falls back to the id as a title', () => {
    expect(parseAsset({ id: 'stable-57d8b1', title: '  ' })?.title).toBe('stable-57d8b1')
  })
})

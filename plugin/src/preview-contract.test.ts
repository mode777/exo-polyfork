import { describe, expect, it } from 'vitest'
import type { PolyforkAsset } from './api'
import {
  PREVIEW_PAYLOAD_VERSION,
  parseSelectionPayload,
  selectionPayload,
} from './preview-contract'

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

describe('preview selection payload', () => {
  it('round-trips a catalogue asset', () => {
    expect(parseSelectionPayload(selectionPayload(asset))).toEqual({
      version: PREVIEW_PAYLOAD_VERSION,
      asset,
    })
  })

  it('copies the asset instead of sharing the catalogue row', () => {
    const payload = selectionPayload(asset)
    expect(payload.asset).not.toBe(asset)
    expect(payload.asset).toEqual(asset)
  })

  it('rejects unknown versions and malformed envelopes', () => {
    expect(parseSelectionPayload(null)).toBeNull()
    expect(parseSelectionPayload('stable-57d8b1')).toBeNull()
    expect(parseSelectionPayload([])).toBeNull()
    expect(parseSelectionPayload({ version: 2, asset })).toBeNull()
    expect(parseSelectionPayload({ asset })).toBeNull()
  })

  it('rejects an unsafe or missing asset id', () => {
    expect(parseSelectionPayload({ version: 1, asset: { id: '../escape' } })).toBeNull()
    expect(parseSelectionPayload({ version: 1, asset: { title: 'No id' } })).toBeNull()
    expect(parseSelectionPayload({ version: 1, asset: null })).toBeNull()
  })

  it('normalizes optional fields through the catalogue parser', () => {
    expect(
      parseSelectionPayload({
        version: 1,
        asset: {
          id: 'general-base',
          title: '  ',
          thumbnail: 'https://evil.example/hero.png',
          has_rig: true,
        },
      }),
    ).toEqual({
      version: 1,
      asset: {
        id: 'general-base',
        title: 'general-base',
        class: 'unknown',
        kit: null,
        triangles: 0,
        thumbnail: null,
        free: false,
        hasRig: true,
        hasSkeleton: false,
        remixable: false,
      },
    })
  })
})

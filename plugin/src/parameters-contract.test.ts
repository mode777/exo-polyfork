import { describe, expect, it } from 'vitest'
import type { AssetParamsSchema } from './api'
import {
  PARAMETERS_PAYLOAD_VERSION,
  paramsChange,
  paramsState,
  parseParamsChange,
  parseParamsState,
} from './parameters-contract'

const schema: AssetParamsSchema = {
  params: [
    {
      key: 'faction',
      type: 'choice',
      label: 'Faction',
      describe: '',
      default: 'none',
      options: ['none', 'wei'],
    },
    {
      key: 'roofPitch',
      type: 'range',
      label: 'Roof pitch',
      describe: '',
      default: 27,
      min: 20,
      max: 36,
      step: 1,
    },
  ],
  presets: {
    none: { roofPitch: 27 },
    wei: { roofPitch: 31 },
  },
}

describe('parameters state payload', () => {
  it('round-trips schema, values and instance', () => {
    const state = paramsState(
      'preview-1234567890abcdef',
      'stable-57d8b1',
      'Stable',
      'ready',
      schema,
      {
        faction: 'wei',
        roofPitch: 30,
      },
    )
    expect(parseParamsState(state)).toEqual(state)
  })

  it('normalizes out-of-schema values when received', () => {
    const parsed = parseParamsState({
      version: PARAMETERS_PAYLOAD_VERSION,
      instanceId: 'preview-1234567890abcdef',
      assetId: 'stable-57d8b1',
      title: 'Stable',
      phase: 'ready',
      message: '',
      params: schema.params,
      values: { faction: 'nope', roofPitch: 99, extra: 1 },
    })
    expect(parsed?.values).toEqual({ roofPitch: 36 })
  })

  it('rejects unsafe ids, versions, instance ids and phases', () => {
    const base = {
      version: PARAMETERS_PAYLOAD_VERSION,
      instanceId: 'preview-1234567890abcdef',
      assetId: 'stable-57d8b1',
      title: 'Stable',
      phase: 'ready',
      params: [],
      values: {},
    }
    expect(parseParamsState(null)).toBeNull()
    expect(parseParamsState({ ...base, version: 1 })).toBeNull()
    expect(parseParamsState({ ...base, instanceId: '' })).toBeNull()
    expect(parseParamsState({ ...base, instanceId: 'x'.repeat(257) })).toBeNull()
    expect(parseParamsState({ ...base, assetId: '../escape' })).toBeNull()
    expect(parseParamsState({ ...base, phase: 'sideways' })).toBeNull()
  })
})

describe('parameter change payload', () => {
  it('targets one preview instance and copies primitive values', () => {
    const change = paramsChange('preview-1234567890abcdef', 'stable-57d8b1', {
      faction: 'wei',
      roofPitch: 30,
      fire: true,
      loose: undefined as never,
    })
    expect(parseParamsChange(change)).toEqual({
      version: PARAMETERS_PAYLOAD_VERSION,
      instanceId: 'preview-1234567890abcdef',
      assetId: 'stable-57d8b1',
      values: {
        faction: 'wei',
        roofPitch: 30,
        fire: true,
      },
    })
  })

  it('rejects malformed changes', () => {
    expect(parseParamsChange(null)).toBeNull()
    expect(
      parseParamsChange({
        version: PARAMETERS_PAYLOAD_VERSION,
        instanceId: '',
        assetId: 'stable-57d8b1',
        values: {},
      }),
    ).toBeNull()
    expect(
      parseParamsChange({
        version: PARAMETERS_PAYLOAD_VERSION,
        instanceId: 'preview-1234567890abcdef',
        assetId: 'stable-57d8b1',
        values: 'nope',
      }),
    ).toBeNull()
    expect(
      parseParamsChange({
        version: PARAMETERS_PAYLOAD_VERSION,
        instanceId: 'preview-1234567890abcdef',
        assetId: '../escape',
        values: {},
      }),
    ).toBeNull()
  })
})

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
}

describe('parameters state payload', () => {
  it('round-trips schema and values', () => {
    const state = paramsState('stable-57d8b1', 'Stable', 'ready', schema, {
      faction: 'wei',
      roofPitch: 30,
    })
    expect(parseParamsState(state)).toEqual(state)
  })

  it('normalizes out-of-schema values when received', () => {
    const parsed = parseParamsState({
      version: PARAMETERS_PAYLOAD_VERSION,
      assetId: 'stable-57d8b1',
      title: 'Stable',
      phase: 'ready',
      message: '',
      params: schema.params,
      values: { faction: 'nope', roofPitch: 99, extra: 1 },
    })
    expect(parsed?.values).toEqual({ roofPitch: 36 })
  })

  it('rejects unsafe ids, versions and phases', () => {
    expect(parseParamsState(null)).toBeNull()
    expect(
      parseParamsState({
        version: 2,
        assetId: 'stable-57d8b1',
        title: 'Stable',
        phase: 'ready',
        params: [],
        values: {},
      }),
    ).toBeNull()
    expect(
      parseParamsState({
        version: 1,
        assetId: '../escape',
        title: 'Nope',
        phase: 'ready',
        params: [],
        values: {},
      }),
    ).toBeNull()
    expect(
      parseParamsState({
        version: 1,
        assetId: 'stable-57d8b1',
        title: 'Stable',
        phase: 'sideways',
        params: [],
        values: {},
      }),
    ).toBeNull()
  })
})

describe('parameter change payload', () => {
  it('copies primitive values and drops unsupported ones', () => {
    const change = paramsChange('stable-57d8b1', {
      faction: 'wei',
      roofPitch: 30,
      fire: true,
      loose: undefined as never,
    })
    expect(parseParamsChange(change)?.values).toEqual({
      faction: 'wei',
      roofPitch: 30,
      fire: true,
    })
  })

  it('rejects malformed changes', () => {
    expect(parseParamsChange(null)).toBeNull()
    expect(
      parseParamsChange({ version: 1, assetId: 'stable-57d8b1', values: 'nope' }),
    ).toBeNull()
    expect(parseParamsChange({ version: 1, assetId: '../escape', values: {} })).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { defaultParamValues, type AssetParamsSchema } from './api'
import { randomizeParamValues, type RandomSource } from './randomize'

const schema: AssetParamsSchema = {
  params: [
    {
      key: 'faction',
      type: 'choice',
      label: 'Faction',
      describe: '',
      default: 'none',
      options: ['none', 'wei', 'wu'],
    },
    {
      key: 'roofForm',
      type: 'choice',
      label: 'Roof form',
      describe: '',
      default: 'gable',
      options: ['gable', 'lean-to'],
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
    {
      key: 'fire',
      type: 'toggle',
      label: 'Fire',
      describe: '',
      default: true,
    },
    {
      key: 'ridge',
      type: 'color',
      label: 'Ridge',
      describe: '',
      default: '#6d6660',
    },
    {
      key: 'lacquer',
      type: 'color',
      label: 'Lacquer',
      describe: '',
      default: '#8c3a2c',
    },
  ],
  presets: {
    none: { ridge: '#6d6660', lacquer: '#8c3a2c' },
    wei: { ridge: '#688795', lacquer: '#749aa5' },
    wu: { ridge: '#8c3a2c' },
  },
}

function sequence(draws: number[]): RandomSource {
  return () => {
    const draw = draws.shift()
    if (draw === undefined) throw new Error('Unexpected random draw.')
    return draw
  }
}

describe('randomizeParamValues', () => {
  it('rolls ranges, choices and toggles but never draws for colours', () => {
    const current = {
      faction: 'none',
      roofForm: 'gable',
      roofPitch: 27,
      fire: true,
      ridge: '#123456',
      lacquer: '#abcdef',
    }
    const draws = [0.1, 0.2, 0.99, 0.1]

    const result = randomizeParamValues(schema, current, sequence(draws))

    expect(draws).toEqual([])
    expect(result).toEqual({
      faction: 'none',
      roofForm: 'gable',
      roofPitch: 36,
      fire: false,
      ridge: '#123456',
      lacquer: '#abcdef',
    })
  })

  it('applies the preset of a randomized colourway', () => {
    const result = randomizeParamValues(
      schema,
      defaultParamValues(schema),
      sequence([0.5, 0.5, 0.5, 0.5]),
    )

    expect(result).toMatchObject({
      faction: 'wei',
      roofForm: 'lean-to',
      roofPitch: 28,
      fire: true,
      ridge: '#688795',
      lacquer: '#749aa5',
    })
  })

  it('keeps the edited colours when the colourway does not change', () => {
    const current = {
      ...defaultParamValues(schema),
      faction: 'none',
      ridge: '#123456',
      lacquer: '#abcdef',
    }

    const result = randomizeParamValues(schema, current, sequence([0.1, 0.9, 0.5, 0.5]))

    expect(result).toMatchObject({
      faction: 'none',
      roofForm: 'lean-to',
      ridge: '#123456',
      lacquer: '#abcdef',
    })
  })

  it('quantizes ranges to their step and clamps the random source', () => {
    const rangeSchema: AssetParamsSchema = {
      params: [
        {
          key: 'level',
          type: 'range',
          label: 'Level',
          describe: '',
          default: 0,
          min: 0,
          max: 1,
          step: 0.1,
        },
      ],
      presets: {},
    }

    expect(randomizeParamValues(rangeSchema, {}, () => 0).level).toBe(0)
    expect(randomizeParamValues(rangeSchema, {}, () => 0.55).level).toBe(0.6)
    expect(randomizeParamValues(rangeSchema, {}, () => 0.999).level).toBe(1)
    expect(randomizeParamValues(rangeSchema, {}, () => -5).level).toBe(0)
    expect(randomizeParamValues(rangeSchema, {}, () => 5).level).toBe(1)
  })
})

import {
  applyParamPreset,
  type AssetParamDefinition,
  type AssetParamValue,
  type AssetParamsSchema,
} from './api'

export type RandomSource = () => number

/**
 * Build a randomized set of parameter values. Colour knobs keep their current
 * values: only ranges, choices (including `colorway`/`faction`) and toggles are
 * rolled. A changed choice still applies its named preset, exactly as selecting
 * it in the panel does, so a randomized colourway may recolour the knobs its
 * preset covers.
 */
export function randomizeParamValues(
  schema: AssetParamsSchema,
  values: Record<string, AssetParamValue>,
  random: RandomSource = Math.random,
): Record<string, AssetParamValue> {
  const chosen: Record<string, AssetParamValue> = {}
  for (const definition of schema.params) {
    chosen[definition.key] = randomizeValue(
      definition,
      values[definition.key] ?? definition.default,
      random,
    )
  }

  let next = chosen
  for (const definition of schema.params) {
    if (definition.type !== 'choice') continue
    const selected = chosen[definition.key]
    if (typeof selected !== 'string') continue
    if (selected === (values[definition.key] ?? definition.default)) continue
    if (!schema.presets[selected]) continue
    next = applyParamPreset(schema, next, selected)
  }
  return next
}

function randomizeValue(
  definition: AssetParamDefinition,
  current: AssetParamValue,
  random: RandomSource,
): AssetParamValue {
  if (definition.type === 'color') return current

  const unit = nextUnit(random)
  if (definition.type === 'toggle') return unit >= 0.5

  if (definition.type === 'choice') {
    const options = definition.options ?? []
    if (options.length === 0) return current
    const index = Math.min(options.length - 1, Math.floor(unit * options.length))
    return options[index]
  }

  const min = definition.min ?? 0
  const max = definition.max ?? 1
  if (max <= min) return min

  const step =
    typeof definition.step === 'number' && definition.step > 0 ? definition.step : 0.01
  const steps = Math.max(0, Math.floor((max - min) / step + 1e-9))
  const index = Math.min(steps, Math.floor(unit * (steps + 1)))
  return quantize(Math.min(max, min + index * step))
}

/** `Math.random` is [0, 1); clamp injected sources into the same interval. */
function nextUnit(random: RandomSource): number {
  const value = random()
  if (!Number.isFinite(value)) return 0
  return Math.min(1 - Number.EPSILON, Math.max(0, value))
}

function quantize(value: number): number {
  return Number(value.toFixed(6))
}

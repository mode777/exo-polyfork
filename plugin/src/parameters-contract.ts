import {
  isSafeAssetId,
  parseParamDefinitions,
  parseParamPresets,
  sanitizeParamValues,
  type AssetParamDefinition,
  type AssetParamValue,
  type AssetParamsSchema,
} from './api'

/**
 * The parameters panel is a secondary (right side bar) panel. The preview view
 * owns the schema and the current values; this module is the validated wire
 * format both frames use over the plugin-local channel.
 */
export const PARAMETERS_PANEL_ID = 'asset-params'
export const PARAMETERS_STATE_TOPIC = 'local/asset-params-state'
export const PARAMETERS_CHANGE_TOPIC = 'local/asset-params-change'
export const PARAMETERS_READY_TOPIC = 'local/asset-params-ready'
export const PARAMETERS_PAYLOAD_VERSION = 1

export type ParametersPhase = 'loading' | 'ready' | 'unavailable' | 'error'

export interface AssetParamsState {
  version: typeof PARAMETERS_PAYLOAD_VERSION
  assetId: string
  title: string
  phase: ParametersPhase
  message: string
  params: AssetParamDefinition[]
  presets: Record<string, Record<string, AssetParamValue>>
  values: Record<string, AssetParamValue>
}

export interface AssetParamsChange {
  version: typeof PARAMETERS_PAYLOAD_VERSION
  assetId: string
  values: Record<string, AssetParamValue>
}

export function paramsState(
  assetId: string,
  title: string,
  phase: ParametersPhase,
  schema: AssetParamsSchema | null,
  values: Record<string, AssetParamValue>,
  message = '',
): AssetParamsState {
  return {
    version: PARAMETERS_PAYLOAD_VERSION,
    assetId,
    title,
    phase,
    message,
    params: schema ? schema.params.map((definition) => ({ ...definition })) : [],
    presets: schema
      ? Object.fromEntries(
          Object.entries(schema.presets).map(([name, preset]) => [name, { ...preset }]),
        )
      : {},
    values: { ...values },
  }
}

export function parseParamsState(value: unknown): AssetParamsState | null {
  const record = asRecord(value)
  if (!record || record.version !== PARAMETERS_PAYLOAD_VERSION) return null
  const assetId = typeof record.assetId === 'string' ? record.assetId : ''
  if (!isSafeAssetId(assetId)) return null
  if (!isParametersPhase(record.phase)) return null

  const params = parseParamDefinitions(record.params)
  if (!params) return null
  const presets = parseParamPresets(record.presets)
  const schema: AssetParamsSchema = { params, presets }
  const values = sanitizeParamValues(schema, record.values)

  return {
    version: PARAMETERS_PAYLOAD_VERSION,
    assetId,
    title: typeof record.title === 'string' && record.title.trim() ? record.title : assetId,
    phase: record.phase,
    message: typeof record.message === 'string' ? record.message : '',
    params,
    presets,
    values,
  }
}

export function paramsChange(
  assetId: string,
  values: Record<string, AssetParamValue>,
): AssetParamsChange {
  return { version: PARAMETERS_PAYLOAD_VERSION, assetId, values: { ...values } }
}

export function parseParamsChange(value: unknown): AssetParamsChange | null {
  const record = asRecord(value)
  if (!record || record.version !== PARAMETERS_PAYLOAD_VERSION) return null
  const assetId = typeof record.assetId === 'string' ? record.assetId : ''
  if (!isSafeAssetId(assetId)) return null
  const values = asRecord(record.values)
  if (!values) return null

  const sanitized: Record<string, AssetParamValue> = {}
  for (const [key, item] of Object.entries(values)) {
    if (typeof item === 'string' || typeof item === 'boolean') sanitized[key] = item
    else if (typeof item === 'number' && Number.isFinite(item)) sanitized[key] = item
  }

  return { version: PARAMETERS_PAYLOAD_VERSION, assetId, values: sanitized }
}

function isParametersPhase(value: unknown): value is ParametersPhase {
  return value === 'loading' || value === 'ready' || value === 'unavailable' || value === 'error'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

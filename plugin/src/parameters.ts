import '@exo/plugin-sdk/theme.css'
import './panel.css'
import './parameters.css'
import { connectBrowserPlugin } from '@exo/plugin-sdk/browser'
import type { ViewActivePayload, ViewClient } from '@exo/plugin-sdk'
import { followTheme } from '@exo/plugin-sdk/theme'
import {
  applyParamPreset,
  defaultParamValues,
  type AssetParamDefinition,
  type AssetParamValue,
} from './api'
import {
  PARAMETERS_CHANGE_TOPIC,
  PARAMETERS_PANEL_ID,
  PARAMETERS_READY_TOPIC,
  PARAMETERS_STATE_TOPIC,
  paramsChange,
  parseParamsState,
  type AssetParamsState,
} from './parameters-contract'
import { PREVIEW_VIEW_ID } from './preview-contract'

const app = getElement<HTMLDivElement>('parameters')
const titleLine = getElement<HTMLHeadingElement>('params-title')
const idLine = getElement<HTMLElement>('params-id')
const statusBox = getElement<HTMLDivElement>('params-status')
const messageLine = getElement<HTMLParagraphElement>('params-message')
const body = getElement<HTMLElement>('params-body')
const countLine = getElement<HTMLSpanElement>('params-count')
const fields = getElement<HTMLDivElement>('params-fields')
const resetButton = getElement<HTMLButtonElement>('params-reset')

let viewClient: ViewClient | null = null
let state: AssetParamsState | null = null
const states = new Map<string, AssetParamsState>()
let values: Record<string, AssetParamValue> = {}
let activeInstanceId: string | null = null
let renderedInstanceId = ''
let publishFrame: number | undefined
let disposed = false
let stopTheme: (() => void) | undefined

async function boot(): Promise<void> {
  const connection = await connectBrowserPlugin()
  if (connection.mode !== 'view') {
    throw new Error('This page must be mounted as an Exo panel.')
  }
  const view = connection.view
  viewClient = view

  const info = view.view
  if (info.kind !== 'panel' || info.id !== PARAMETERS_PANEL_ID) {
    throw new Error('This page must be mounted as the Polyfork parameters panel.')
  }

  document.title = `${info.title} — Polyfork`
  bindEvents()

  const active = view.activeContentView
  activeInstanceId =
    active && active.pluginId === view.initialization.plugin.id && active.viewId === PREVIEW_VIEW_ID
      ? active.instanceId
      : null

  view.onDispose(() => {
    disposed = true
    if (publishFrame !== undefined) window.cancelAnimationFrame(publishFrame)
    stopTheme?.()
    stopTheme = undefined
  })
  view.onError((error) => {
    console.warn('[polyfork] shell error', error)
  })

  setupTheme(view)

  await joinParametersChannel(view)
}

async function joinParametersChannel(view: ViewClient): Promise<void> {
  if (
    !view.capabilities.localEvents ||
    !view.initialization.permissions.includes('events:subscribe')
  ) {
    showStatus('This Exo version cannot synchronise the asset preview parameters.')
    app.dataset.phase = 'error'
    return
  }

  try {
    await view.subscribeLocal(PARAMETERS_STATE_TOPIC)
    view.onLocalEvent(PARAMETERS_STATE_TOPIC, (event) => {
      const next = parseParamsState(event.payload)
      if (next) receiveState(next)
    })
  } catch (error) {
    console.warn('[polyfork] parameter channel is unavailable', error)
    showStatus('The Polyfork parameter channel is unavailable.')
    app.dataset.phase = 'error'
    return
  }

  try {
    await view.subscribe('view/active')
    view.onEvent('view/active', (event) => {
      applyActiveEvent(event.payload, view.initialization.plugin.id)
    })
  } catch (error) {
    console.warn('[polyfork] active preview tracking is unavailable', error)
  }

  await requestStateReplay()
  renderActiveState()
}

async function requestStateReplay(): Promise<void> {
  const client = viewClient
  if (!client || disposed) return
  try {
    await client.publishLocal(PARAMETERS_READY_TOPIC, { version: 1 })
  } catch (error) {
    if (!disposed) console.warn('[polyfork] parameter state request failed', error)
  }
}

function applyActiveEvent(value: unknown, pluginId: string): void {
  const event = parseActiveEvent(value)
  if (!event || event.pluginId !== pluginId) return

  activeInstanceId =
    event.active && event.viewId === PREVIEW_VIEW_ID ? event.instanceId : null
  renderActiveState()
  if (activeInstanceId) void requestStateReplay()
}

function parseActiveEvent(value: unknown): ViewActivePayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.pluginId !== 'string') return null
  if (record.active === false) return { pluginId: record.pluginId, active: false }
  if (record.active !== true) return null
  if (typeof record.viewId !== 'string') return null
  if (typeof record.instanceId !== 'string') return null
  if (typeof record.instanceKey !== 'string') return null
  return {
    pluginId: record.pluginId,
    active: true,
    viewId: record.viewId,
    instanceId: record.instanceId,
    instanceKey: record.instanceKey,
  }
}

function bindEvents(): void {
  resetButton.addEventListener('click', () => {
    if (!state || state.phase !== 'ready' || state.params.length === 0) return
    values = defaultParamValues({ params: state.params, presets: state.presets })
    state = { ...state, values: { ...values } }
    syncControlValues()
    queuePublish()
  })
}

/**
 * Every preview publishes its own schema and values. Cache them by instance so
 * switching tabs is instant; the shell's `view/active` context selects the
 * instance that owns the shared panel.
 */
function receiveState(next: AssetParamsState): void {
  states.set(next.instanceId, next)
  if (next.instanceId === activeInstanceId) renderState(next)
}

function renderActiveState(): void {
  if (!activeInstanceId) {
    renderInactiveState()
    return
  }
  const active = states.get(activeInstanceId)
  if (active) renderState(active)
  else renderWaitingState()
}

function renderWaitingState(): void {
  state = null
  renderedInstanceId = ''
  values = {}
  app.dataset.assetId = ''
  app.dataset.phase = 'loading'
  titleLine.textContent = 'Loading preview'
  titleLine.title = ''
  idLine.textContent = ''
  idLine.title = ''
  body.hidden = true
  statusBox.hidden = false
  resetButton.disabled = true
  fields.replaceChildren()
  showStatus('Loading the active preview parameters…')
}

function renderState(next: AssetParamsState): void {
  const instanceChanged = next.instanceId !== renderedInstanceId
  state = next
  renderedInstanceId = next.instanceId
  app.dataset.assetId = next.assetId
  app.dataset.phase = next.phase

  titleLine.textContent = next.title
  titleLine.title = next.title
  idLine.textContent = next.assetId
  idLine.title = next.assetId

  if (next.phase === 'ready' && next.params.length > 0) {
    statusBox.hidden = true
    body.hidden = false
    countLine.textContent = `${next.params.length} ${
      next.params.length === 1 ? 'parameter' : 'parameters'
    }`
    resetButton.disabled = false
    if (instanceChanged || fields.childElementCount === 0) {
      values = { ...next.values }
      buildFields(next.params)
    } else {
      values = { ...next.values }
      syncControlValues()
    }
    return
  }

  body.hidden = true
  statusBox.hidden = false
  resetButton.disabled = true
  renderedInstanceId = ''
  values = {}
  fields.replaceChildren()
  showStatus(messageFor(next))
}

function renderInactiveState(): void {
  state = null
  renderedInstanceId = ''
  values = {}
  app.dataset.assetId = ''
  app.dataset.phase = 'waiting'
  titleLine.textContent = 'No active preview'
  titleLine.title = ''
  idLine.textContent = ''
  idLine.title = ''
  body.hidden = true
  statusBox.hidden = false
  resetButton.disabled = true
  fields.replaceChildren()
  showStatus('No Polyfork preview is active. Select an asset to edit its parameters.')
}

function messageFor(next: AssetParamsState): string {
  if (next.phase === 'loading') return 'Loading the Polyfork parameter schema…'
  if (next.phase === 'unavailable') {
    return next.message || 'This asset has no adjustable parameters.'
  }
  if (next.phase === 'error') {
    return next.message || 'The Polyfork parameter schema could not be loaded.'
  }
  return 'Select an asset to load its adjustable parameters.'
}

function showStatus(message: string): void {
  messageLine.textContent = message
}

function buildFields(definitions: AssetParamDefinition[]): void {
  fields.replaceChildren()
  const fragment = document.createDocumentFragment()
  for (const definition of definitions) fragment.append(createField(definition))
  fields.append(fragment)
}

function createField(definition: AssetParamDefinition): HTMLElement {
  const field = document.createElement('div')
  field.className = 'param-field'
  field.dataset.paramKey = definition.key

  const label = document.createElement('label')
  label.className = 'param-label'
  label.htmlFor = `param-${definition.key}`
  label.textContent = definition.label

  const value = values[definition.key] ?? definition.default
  const control = createControl(definition, value)
  field.append(label)

  if (definition.type === 'toggle') {
    const row = document.createElement('div')
    row.className = 'param-toggle-row'
    row.append(control)
    field.append(row)
  } else if (definition.type === 'color') {
    const row = document.createElement('div')
    row.className = 'param-color-row'
    const code = document.createElement('code')
    code.className = 'param-color-code'
    code.textContent = String(value)
    control.dataset.valueLabel = definition.key
    row.append(control, code)
    field.append(row)
  } else if (definition.type === 'range') {
    const row = document.createElement('div')
    row.className = 'param-range-row'
    const output = document.createElement('output')
    output.className = 'param-range-value'
    output.htmlFor = `param-${definition.key}`
    output.dataset.valueLabel = definition.key
    output.textContent = formatNumber(value)
    row.append(control, output)
    if (control instanceof HTMLInputElement) {
      bindRangeDrag(control, row, definition, output)
    }
    field.append(row)
  } else {
    field.append(control)
  }

  if (definition.describe) {
    const description = document.createElement('p')
    description.className = 'param-description'
    description.textContent = definition.describe
    description.title = definition.describe
    field.append(description)
  }

  return field
}

function createControl(
  definition: AssetParamDefinition,
  value: AssetParamValue,
): HTMLInputElement | HTMLSelectElement {
  if (definition.type === 'choice') {
    const select = document.createElement('select')
    select.id = `param-${definition.key}`
    select.dataset.paramInput = definition.key
    for (const option of definition.options ?? []) {
      select.append(new Option(option, option))
    }
    select.value = String(value)
    select.addEventListener('change', () => {
      setChoiceValue(definition.key, select.value)
    })
    return select
  }

  const input = document.createElement('input')
  input.id = `param-${definition.key}`
  input.dataset.paramInput = definition.key

  if (definition.type === 'color') {
    input.type = 'color'
    input.value = String(value)
    input.addEventListener('input', () => {
      setValue(definition.key, input.value.toLowerCase())
      const code = fieldValueLabel(definition.key)
      if (code) code.textContent = input.value.toLowerCase()
    })
    return input
  }

  if (definition.type === 'range') {
    input.type = 'range'
    input.min = String(definition.min ?? 0)
    input.max = String(definition.max ?? 1)
    input.step = String(definition.step ?? 0.01)
    input.value = String(value)
    input.addEventListener('input', () => {
      const numeric = Number(input.value)
      setValue(definition.key, numeric)
      const output = fieldValueLabel(definition.key)
      if (output) output.textContent = formatNumber(numeric)
    })
    return input
  }

  input.type = 'checkbox'
  input.checked = value === true
  input.addEventListener('change', () => {
    setValue(definition.key, input.checked)
  })
  return input
}

/**
 * Native range dragging loses its implicit pointer capture when the shell moves
 * focus away from the panel. Capture on the unscrollable wrapper instead, so a
 * drag keeps streaming values even after the input blurs.
 */
function bindRangeDrag(
  input: HTMLInputElement,
  surface: HTMLElement,
  definition: AssetParamDefinition,
  output: HTMLOutputElement,
): void {
  let pointerId: number | null = null

  const update = (clientX: number): void => {
    const rect = input.getBoundingClientRect()
    if (rect.width <= 0) return

    const min = definition.min ?? 0
    const max = definition.max ?? 1
    const step = definition.step && definition.step > 0 ? definition.step : 0.01
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const raw = min + ratio * (max - min)
    const stepped = min + Math.round((raw - min) / step) * step
    const value = Number(Math.min(max, Math.max(min, stepped)).toFixed(6))

    if (input.value !== String(value)) input.value = String(value)
    setValue(definition.key, value)
    output.textContent = formatNumber(value)
  }

  surface.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    pointerId = event.pointerId
    surface.setPointerCapture(event.pointerId)
    input.focus({ preventScroll: true })
    update(event.clientX)
  })

  surface.addEventListener('pointermove', (event) => {
    if (pointerId === null || event.pointerId !== pointerId) return
    event.preventDefault()
    update(event.clientX)
  })

  const finish = (event: PointerEvent): void => {
    if (pointerId === null || event.pointerId !== pointerId) return
    pointerId = null
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId)
    }
  }

  surface.addEventListener('pointerup', finish)
  surface.addEventListener('pointercancel', finish)
  surface.addEventListener('lostpointercapture', finish)
}

function setChoiceValue(key: string, value: string): void {
  let next = { ...values, [key]: value }
  if (state) next = applyParamPreset({ params: state.params, presets: state.presets }, next, value)
  values = next
  if (state) state = { ...state, values: { ...values } }
  syncControlValues()
  queuePublish()
}

function setValue(key: string, value: AssetParamValue): void {
  values = { ...values, [key]: value }
  if (state) state = { ...state, values: { ...values } }
  queuePublish()
}

function fieldValueLabel(key: string): HTMLElement | null {
  return fields.querySelector<HTMLElement>(`[data-value-label="${key}"]`)
}

function syncControlValues(): void {
  for (const definition of state?.params ?? []) {
    const control = fields.querySelector<HTMLInputElement | HTMLSelectElement>(
      `[data-param-input="${definition.key}"]`,
    )
    if (!control) continue
    const value = values[definition.key] ?? definition.default
    if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      control.checked = value === true
    } else {
      control.value = String(value)
    }
    const label = fieldValueLabel(definition.key)
    if (label) label.textContent = String(value)
  }
}

function queuePublish(): void {
  if (publishFrame !== undefined) return
  publishFrame = window.requestAnimationFrame(() => {
    publishFrame = undefined
    publishValues()
  })
}

function publishValues(): void {
  const client = viewClient
  const current = state
  if (
    !client ||
    !current ||
    disposed ||
    current.phase !== 'ready' ||
    current.instanceId !== activeInstanceId
  ) {
    return
  }

  void client
    .publishLocal(PARAMETERS_CHANGE_TOPIC, paramsChange(current.instanceId, current.assetId, values))
    .catch((error: unknown) => {
      if (!disposed) console.warn('[polyfork] parameter change publish failed', error)
    })
}

function formatNumber(value: AssetParamValue): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value)
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)))
}

function setupTheme(view: ViewClient): void {
  void followTheme(view)
    .then((stop) => {
      if (disposed) stop()
      else stopTheme = stop
    })
    .catch((error: unknown) => {
      console.info('[polyfork] theme changes are not available', error)
    })
}

function showBootError(error: unknown): void {
  app.dataset.phase = 'error'
  app.hidden = true
  const box = document.getElementById('boot-error')
  const detail = document.getElementById('boot-error-detail')
  if (box) box.hidden = false
  if (detail) detail.textContent = error instanceof Error ? error.message : String(error)
  console.error('[polyfork] parameters boot failed', error)
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`The Polyfork parameters panel is missing #${id}.`)
  return element as T
}

void boot().catch(showBootError)

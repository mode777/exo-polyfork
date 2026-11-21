import { connectBrowserPlugin } from '@exo/plugin-sdk/browser'
import type { ViewClient } from '@exo/plugin-sdk'
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
import {
  PARAMETERS_IDLE_TIMEOUT_MS,
  PREVIEW_ALIVE_TOPIC,
  PREVIEW_CLOSED_TOPIC,
} from './preview-contract'

type ThemeName = 'dark' | 'light' | 'high-contrast'

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
let values: Record<string, AssetParamValue> = {}
let renderedAssetId = ''
let publishFrame: number | undefined
let watchdogTimer: number | undefined
let disposed = false

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

  applyTheme(view.initialization.theme)
  document.title = `${info.title} — Polyfork`
  bindEvents()

  view.onDispose(() => {
    disposed = true
    stopWatchdog()
    if (publishFrame !== undefined) window.cancelAnimationFrame(publishFrame)
  })
  view.onError((error) => {
    console.warn('[polyfork] shell error', error)
  })

  if (view.initialization.permissions.includes('events:subscribe')) {
    void view.subscribe('theme/changed').catch((error: unknown) => {
      console.info('[polyfork] theme changes are not available', error)
    })
    view.onEvent('theme/changed', (event) => {
      if (isThemeName(event.payload.theme)) applyTheme(event.payload.theme)
    })
  }

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
      if (next) renderState(next)
    })
    await view.subscribeLocal(PREVIEW_CLOSED_TOPIC)
    view.onLocalEvent(PREVIEW_CLOSED_TOPIC, () => {
      stopWatchdog()
      void view.requestPanel(PARAMETERS_PANEL_ID, 'hide').catch(() => undefined)
    })
    await view.subscribeLocal(PREVIEW_ALIVE_TOPIC)
    view.onLocalEvent(PREVIEW_ALIVE_TOPIC, () => armWatchdog(view))
    armWatchdog(view)
    await view.publishLocal(PARAMETERS_READY_TOPIC, {
      version: 1,
    })
  } catch (error) {
    console.warn('[polyfork] parameter channel is unavailable', error)
    showStatus('The Polyfork parameter channel is unavailable.')
    app.dataset.phase = 'error'
  }
}

/**
 * The panel has no shell signal for "the last content view closed", so it
 * watches the preview's heartbeat. No beat means no open preview, and the panel
 * leaves the right side bar.
 */
function armWatchdog(view: ViewClient): void {
  stopWatchdog()
  watchdogTimer = window.setTimeout(() => {
    watchdogTimer = undefined
    // Background tabs throttle both timers; wait for a real beat first.
    if (document.visibilityState === 'hidden') {
      armWatchdog(view)
      return
    }
    void view.requestPanel(PARAMETERS_PANEL_ID, 'hide').catch(() => undefined)
  }, PARAMETERS_IDLE_TIMEOUT_MS)
}

function stopWatchdog(): void {
  if (watchdogTimer === undefined) return
  window.clearTimeout(watchdogTimer)
  watchdogTimer = undefined
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

function renderState(next: AssetParamsState): void {
  const assetChanged = next.assetId !== renderedAssetId
  state = next
  renderedAssetId = next.assetId
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
    if (assetChanged || fields.childElementCount === 0) {
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
  renderedAssetId = ''
  values = {}
  fields.replaceChildren()
  showStatus(messageFor(next))
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
  if (!client || !current || disposed || current.phase !== 'ready') return

  void client
    .publishLocal(PARAMETERS_CHANGE_TOPIC, paramsChange(current.assetId, values))
    .catch((error: unknown) => {
      console.warn('[polyfork] parameter change publish failed', error)
    })
}

function formatNumber(value: AssetParamValue): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value)
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)))
}

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
}

function isThemeName(value: unknown): value is ThemeName {
  return value === 'dark' || value === 'light' || value === 'high-contrast'
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

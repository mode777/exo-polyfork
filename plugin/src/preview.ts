import '@exo/plugin-sdk/theme.css'
import './panel.css'
import './preview.css'
import { connectBrowserPlugin } from '@exo/plugin-sdk/browser'
import {
  ExoProtocolError,
  MAX_NEW_FILE_BYTES,
  type ViewClient,
} from '@exo/plugin-sdk'
import { followTheme } from '@exo/plugin-sdk/theme'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import {
  CATEGORY_OPTIONS,
  applyParamPreset,
  defaultParamValues,
  fetchAssetParams,
  sanitizeParamValues,
  type AssetParamValue,
  type AssetParamsSchema,
  type PolyforkAsset,
} from './api'
import { disposeObject3D, loadAssetObject } from './asset-module'
import { buildAssetConfigExport, exportFileName } from './exports'
import {
  ASSET_SELECTED_TOPIC,
  PREVIEW_PAYLOAD_VERSION,
  PREVIEW_READY_TOPIC,
  PREVIEW_VIEW_ID,
  parseSelectionPayload,
} from './preview-contract'
import { PreviewEnvironment, enableAssetShadows } from './preview-environment'
import {
  PARAMETERS_CHANGE_TOPIC,
  PARAMETERS_READY_TOPIC,
  PARAMETERS_STATE_TOPIC,
  paramsState,
  parseParamsChange,
  type ParametersPhase,
} from './parameters-contract'

type PreviewPhase = 'booting' | 'loading' | 'ready' | 'fallback' | 'error' | 'empty'

const CLASS_LABELS = new Map(
  CATEGORY_OPTIONS.filter((option) => option.value).map((option) => [option.value, option.label]),
)
const numberFormat = new Intl.NumberFormat()
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

const app = getElement<HTMLDivElement>('preview')
const stage = getElement<HTMLDivElement>('preview-stage')
const canvas = getElement<HTMLCanvasElement>('preview-canvas')
const titleLine = getElement<HTMLHeadingElement>('asset-title')
const idLine = getElement<HTMLElement>('asset-id')
const metaLine = getElement<HTMLElement>('preview-meta')
const loadingMessage = getElement<HTMLDivElement>('loading')
const errorBox = getElement<HTMLDivElement>('error')
const errorMessage = getElement<HTMLSpanElement>('error-message')
const emptyBox = getElement<HTMLDivElement>('empty')
const fallbackImage = getElement<HTMLImageElement>('fallback')
const hintLine = getElement<HTMLParagraphElement>('preview-hint')
const spinButton = getElement<HTMLButtonElement>('spin')
const resetButton = getElement<HTMLButtonElement>('reset')
const retryButton = getElement<HTMLButtonElement>('retry')
const exportGlbButton = getElement<HTMLButtonElement>('export-glb')
const exportJsonButton = getElement<HTMLButtonElement>('export-json')
const exportStatus = getElement<HTMLParagraphElement>('export-status')

let disposed = false
let stopTheme: (() => void) | undefined
let currentAsset: PolyforkAsset | null = null
let currentObject: THREE.Object3D | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let renderer: THREE.WebGLRenderer | null = null
let controls: OrbitControls | null = null
let environment: PreviewEnvironment | null = null
let resizeObserver: ResizeObserver | null = null
let renderSequence = 0
let objectSequence = 0
let fitPending = false
let autoRotate = !reducedMotion
let exporting = false

let viewClient: ViewClient | null = null
let localEventsReady = false
let paramSchema: AssetParamsSchema | null = null
let paramValues: Record<string, AssetParamValue> = {}
let paramsPhase: ParametersPhase = 'loading'
let paramsMessage = ''
let paramsController: AbortController | null = null
let paramsRenderTimer: number | undefined
let paramsRenderSequence = 0
let paramsRevision = 0

async function boot(): Promise<void> {
  const connection = await connectBrowserPlugin()
  if (connection.mode !== 'view') {
    throw new Error('This page must be mounted as an Exo content view.')
  }
  const view = connection.view
  viewClient = view

  const viewInfo = view.view
  if (viewInfo.kind !== 'content' || viewInfo.id !== PREVIEW_VIEW_ID) {
    throw new Error('This page must be mounted as the Polyfork asset preview.')
  }

  bindChrome()
  observeResize()
  view.onDispose(dispose)
  view.onError((error) => {
    console.warn('[polyfork] shell error', error)
  })
  setupTheme(view)

  void joinSelectionChannel(view)
  void joinParametersChannel(view)

  const initial = parseSelectionPayload(viewInfo.payload)?.asset ?? null
  if (initial) showAsset(initial)
  else showEmpty()
}

function bindChrome(): void {
  setSpin(autoRotate)

  spinButton.addEventListener('click', () => setSpin(!autoRotate))
  resetButton.addEventListener('click', () => {
    fitCamera()
  })
  exportGlbButton.addEventListener('click', () => {
    void exportGlb()
  })
  exportJsonButton.addEventListener('click', () => {
    void exportJson()
  })
  retryButton.addEventListener('click', () => {
    if (!currentAsset) return
    const asset = currentAsset
    currentAsset = null
    showAsset(asset)
  })
  fallbackImage.addEventListener('error', () => {
    if (app.dataset.phase !== 'fallback') return
    showError('The Polyfork preview image could not be loaded.')
  })
}

/**
 * The GLB export rebuilds the model from the current parameter values instead
 * of capturing the live scene: the scene also contains the environment and
 * ground, and a debounced rebuild may still be in flight. Exo's shell owns the
 * Save As dialog and the write; the plugin never picks a workspace path.
 */
async function exportGlb(): Promise<void> {
  const asset = currentAsset
  const client = viewClient
  if (
    disposed ||
    exporting ||
    !asset ||
    !client ||
    paramsPhase === 'loading' ||
    !currentObject ||
    app.dataset.phase !== 'ready'
  ) {
    return
  }

  exporting = true
  updateExportButtons()
  setExportStatus('Building GLB…')
  let previewObject: THREE.Object3D | null = null
  try {
    previewObject = await loadAssetObject(
      asset.id,
      paramsPhase === 'ready' ? paramValues : undefined,
    )
    if (disposed) return
    previewObject.updateMatrixWorld(true)
    const bytes = await exportObjectAsGlb(previewObject)
    if (disposed) return

    const path = await saveGeneratedFile(
      client,
      { bytes },
      exportFileName(asset.id, 'glb'),
    )
    if (disposed) return
    if (path) setExportStatus(`Saved ${path}`)
    else setExportStatus('')
  } catch (error) {
    if (disposed) return
    console.warn(`[polyfork] GLB export failed for ${asset.id}`, error)
    setExportStatus(exportErrorMessage('GLB', error), true)
  } finally {
    if (previewObject) disposeObject3D(previewObject)
    exporting = false
    updateExportButtons()
  }
}

async function exportJson(): Promise<void> {
  const asset = currentAsset
  const client = viewClient
  if (disposed || exporting || !asset || !client || paramsPhase === 'loading') return

  exporting = true
  updateExportButtons()
  setExportStatus('Building JSON…')
  try {
    const config = buildAssetConfigExport(asset, paramValues)
    const text = `${JSON.stringify(config, null, 2)}\n`
    const path = await saveGeneratedFile(
      client,
      { text },
      exportFileName(asset.id, 'json'),
    )
    if (disposed) return
    if (path) setExportStatus(`Saved ${path}`)
    else setExportStatus('')
  } catch (error) {
    if (disposed) return
    console.warn(`[polyfork] JSON export failed for ${asset.id}`, error)
    setExportStatus(exportErrorMessage('JSON', error), true)
  } finally {
    exporting = false
    updateExportButtons()
  }
}

async function saveGeneratedFile(
  client: ViewClient,
  content: { text: string } | { bytes: ArrayBuffer },
  suggestedName: string,
): Promise<string | null> {
  const result = await client.requestNewFile({ ...content, suggestedName })
  return result?.path ?? null
}

async function exportObjectAsGlb(object: THREE.Object3D): Promise<ArrayBuffer> {
  const result = await new GLTFExporter().parseAsync(object, {
    binary: true,
    onlyVisible: true,
  })
  if (!(result instanceof ArrayBuffer)) {
    throw new Error('The GLB exporter returned JSON instead of binary data.')
  }
  if (result.byteLength === 0) throw new Error('The GLB exporter returned an empty file.')
  if (result.byteLength > MAX_NEW_FILE_BYTES) {
    throw new Error(
      `The GLB is ${formatExportBytes(result.byteLength)}; Exo saves generated files up to ${formatExportBytes(MAX_NEW_FILE_BYTES)}.`,
    )
  }
  return result
}

function setExportStatus(message: string, isError = false): void {
  exportStatus.textContent = message
  exportStatus.hidden = message.length === 0
  exportStatus.classList.toggle('is-error', isError && message.length > 0)
  if (message) exportStatus.title = message
  else exportStatus.removeAttribute('title')
}

function updateExportButtons(): void {
  const idle = !exporting && !disposed
  const hasAsset = currentAsset !== null
  const paramsSettled = paramsPhase !== 'loading'
  exportGlbButton.disabled =
    !idle ||
    !hasAsset ||
    !paramsSettled ||
    !currentObject ||
    app.dataset.phase !== 'ready'
  exportJsonButton.disabled = !idle || !hasAsset || !paramsSettled
}

function exportErrorMessage(kind: 'GLB' | 'JSON', error: unknown): string {
  if (error instanceof ExoProtocolError) {
    if (error.code === 'unsupported-message') {
      return `This Exo shell cannot save ${kind} exports.`
    }
    if (error.code === 'permission-denied') {
      return 'Exo has not granted this plugin workspace write access.'
    }
    return `${kind} export failed: ${error.message}`
  }
  return `${kind} export failed: ${error instanceof Error ? error.message : String(error)}`
}

function formatExportBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
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

/**
 * The shell delivers the selection payload once, when the tab is created. A
 * ready handshake lets the panel republish its latest selection, which covers
 * a tab that was already open and a selection that arrived while it booted.
 */
async function joinSelectionChannel(view: ViewClient): Promise<void> {
  if (
    !view.capabilities.localEvents ||
    !view.initialization.permissions.includes('events:subscribe')
  ) {
    return
  }

  try {
    await view.subscribeLocal(ASSET_SELECTED_TOPIC)
    view.onLocalEvent(ASSET_SELECTED_TOPIC, (event) => {
      const selection = parseSelectionPayload(event.payload)
      if (selection) showAsset(selection.asset)
    })
    await view.publishLocal(PREVIEW_READY_TOPIC, { version: PREVIEW_PAYLOAD_VERSION })
  } catch (error) {
    console.warn('[polyfork] preview selection channel is unavailable', error)
  }
}

/**
 * The right side-bar parameters panel is a separate frame. The preview owns the
 * schema and values and publishes them; the panel publishes edits back. A panel
 * that mounts late asks for the current state and gets an immediate replay.
 */
async function joinParametersChannel(view: ViewClient): Promise<void> {
  if (
    !view.capabilities.localEvents ||
    !view.initialization.permissions.includes('events:subscribe')
  ) {
    return
  }

  try {
    await view.subscribeLocal(PARAMETERS_CHANGE_TOPIC)
    view.onLocalEvent(PARAMETERS_CHANGE_TOPIC, (event) => applyParameterChange(event.payload))
    await view.subscribeLocal(PARAMETERS_READY_TOPIC)
    view.onLocalEvent(PARAMETERS_READY_TOPIC, () => publishParamsState())
    localEventsReady = true
    publishParamsState()
  } catch (error) {
    console.warn('[polyfork] parameter channel is unavailable', error)
  }
}

function showAsset(asset: PolyforkAsset): void {
  if (disposed) return
  if (
    currentAsset?.id === asset.id &&
    (app.dataset.phase === 'loading' || app.dataset.phase === 'ready')
  ) {
    return
  }

  currentAsset = asset
  app.dataset.assetId = asset.id
  document.title = `${asset.title} — Polyfork`
  canvas.setAttribute('aria-label', `${asset.title} interactive 3D preview`)

  titleLine.textContent = asset.title
  titleLine.title = asset.title
  idLine.textContent = asset.id
  idLine.title = asset.id
  renderMeta(asset)
  setExportStatus('')
  resetParameters()

  renderSequence += 1
  const sequence = renderSequence
  renderer?.setAnimationLoop(null)
  clearCurrentObject()
  setPhase('loading')
  void loadAssetParameters(asset, sequence)
  void renderAsset(asset, sequence)
}

function resetParameters(): void {
  paramsController?.abort()
  paramsController = null
  if (paramsRenderTimer !== undefined) {
    window.clearTimeout(paramsRenderTimer)
    paramsRenderTimer = undefined
  }
  paramsRenderSequence += 1
  paramSchema = null
  paramValues = {}
  paramsPhase = 'loading'
  paramsMessage = ''
  paramsRevision = 0
  app.dataset.params = '{}'
  app.dataset.paramsRevision = '0'
  publishParamsState()
  updateExportButtons()
}

async function loadAssetParameters(asset: PolyforkAsset, sequence: number): Promise<void> {
  const controller = new AbortController()
  paramsController?.abort()
  paramsController = controller

  try {
    const schema = await fetchAssetParams(asset.id, controller.signal)
    if (disposed || sequence !== renderSequence) return

    if (!schema || schema.params.length === 0) {
      paramSchema = schema
      paramValues = {}
      paramsPhase = 'unavailable'
      paramsMessage = 'This asset has no adjustable parameters.'
    } else {
      paramSchema = schema
      paramValues = defaultParamValues(schema)
      paramsPhase = 'ready'
      paramsMessage = ''
    }
    app.dataset.params = JSON.stringify(paramValues)
  } catch (error) {
    if (disposed || sequence !== renderSequence || controller.signal.aborted) return
    console.warn(`[polyfork] parameters failed for ${asset.id}`, error)
    paramSchema = null
    paramValues = {}
    paramsPhase = 'error'
    paramsMessage = 'The Polyfork parameter schema could not be loaded.'
  }

  if (paramsController === controller) paramsController = null
  publishParamsState()
  updateExportButtons()
}

function publishParamsState(): void {
  const client = viewClient
  const asset = currentAsset
  if (!client || !asset || disposed || !localEventsReady) return

  const payload = paramsState(
    asset.id,
    asset.title,
    paramsPhase,
    paramSchema,
    paramValues,
    paramsMessage,
  )
  void client.publishLocal(PARAMETERS_STATE_TOPIC, payload).catch((error: unknown) => {
    console.warn('[polyfork] parameter state publish failed', error)
  })
}

function applyParameterChange(value: unknown): void {
  const change = parseParamsChange(value)
  const asset = currentAsset
  if (!change || !asset || !paramSchema || change.assetId !== asset.id) return

  const sanitized = sanitizeParamValues(paramSchema, change.values)
  let next = { ...paramValues, ...sanitized }
  let presetChanged = false

  for (const definition of paramSchema.params) {
    if (definition.type !== 'choice') continue
    const selected = sanitized[definition.key]
    if (typeof selected !== 'string' || selected === paramValues[definition.key]) continue
    if (!paramSchema.presets[selected]) continue
    next = applyParamPreset(paramSchema, next, selected)
    presetChanged = true
  }

  paramValues = next
  app.dataset.params = JSON.stringify(paramValues)
  setExportStatus('')
  scheduleParameterRender()
  if (presetChanged) publishParamsState()
}

function scheduleParameterRender(): void {
  if (paramsRenderTimer !== undefined) window.clearTimeout(paramsRenderTimer)
  paramsRenderTimer = window.setTimeout(() => {
    paramsRenderTimer = undefined
    void renderParameterVariant()
  }, 60)
}

async function renderParameterVariant(): Promise<void> {
  const asset = currentAsset
  if (!asset || disposed) return

  const assetSequence = renderSequence
  const sequence = ++paramsRenderSequence
  const objectVersion = ++objectSequence
  try {
    const object = await loadAssetObject(asset.id, paramValues)
    if (
      disposed ||
      assetSequence !== renderSequence ||
      sequence !== paramsRenderSequence ||
      objectVersion !== objectSequence
    ) {
      disposeObject3D(object)
      return
    }

    const graph = ensureScene()
    const previous = currentObject
    currentObject = object
    enableAssetShadows(object)
    graph.scene.add(object)
    object.updateMatrixWorld(true)
    frameEnvironment()
    if (previous) {
      graph.scene.remove(previous)
      disposeObject3D(previous)
    } else if (!fitCamera()) {
      throw new Error('The asset has no measurable bounds.')
    }

    graph.renderer.setAnimationLoop(renderFrame)
    renderFrame()
    setPhase('ready')
    paramsRevision += 1
    app.dataset.paramsRevision = String(paramsRevision)
  } catch (error) {
    if (
      disposed ||
      assetSequence !== renderSequence ||
      sequence !== paramsRenderSequence ||
      objectVersion !== objectSequence
    ) {
      return
    }
    console.warn(`[polyfork] parameter render failed for ${asset.id}`, error)
  }
}

async function renderAsset(asset: PolyforkAsset, sequence: number): Promise<void> {
  const objectVersion = ++objectSequence
  try {
    const object = await loadAssetObject(asset.id)
    if (disposed || sequence !== renderSequence || objectVersion !== objectSequence) {
      disposeObject3D(object)
      return
    }

    const graph = ensureScene()
    clearCurrentObject()
    currentObject = object
    enableAssetShadows(object)
    graph.scene.add(object)
    object.updateMatrixWorld(true)
    frameEnvironment()

    if (!fitCamera()) throw new Error('The asset has no measurable bounds.')
    graph.renderer.setAnimationLoop(renderFrame)
    renderFrame()
    setPhase('ready')
  } catch (error) {
    if (disposed || sequence !== renderSequence || objectVersion !== objectSequence) return
    showFailure(asset, error)
  }
}

function ensureScene(): {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  controls: OrbitControls
} {
  if (scene && camera && renderer && controls) return { scene, camera, renderer, controls }

  const nextRenderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  })
  nextRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  nextRenderer.setSize(1, 1, false)
  nextRenderer.setClearColor(0x000000, 0)
  nextRenderer.outputColorSpace = THREE.SRGBColorSpace
  // Polyfork's palette is authored for no tone mapping; ACES darkens it.
  nextRenderer.toneMapping = THREE.NoToneMapping
  nextRenderer.shadowMap.enabled = true
  nextRenderer.shadowMap.type = THREE.PCFSoftShadowMap
  canvas.addEventListener(
    'webglcontextlost',
    (event) => {
      event.preventDefault()
      nextRenderer.setAnimationLoop(null)
      showError('The WebGL context was lost. Reopen the preview to try again.')
    },
    { once: true },
  )

  const nextScene = new THREE.Scene()
  environment = new PreviewEnvironment(nextRenderer, nextScene)

  const nextCamera = new THREE.PerspectiveCamera(32, 1, 0.001, 100000)
  const nextControls = new OrbitControls(nextCamera, canvas)
  nextControls.enableDamping = true
  nextControls.dampingFactor = 0.08
  nextControls.enablePan = false
  nextControls.autoRotate = autoRotate
  nextControls.autoRotateSpeed = 0.9
  nextControls.minPolarAngle = 0.12
  nextControls.maxPolarAngle = Math.PI - 0.12

  scene = nextScene
  camera = nextCamera
  renderer = nextRenderer
  controls = nextControls
  resize()
  return { scene, camera, renderer, controls }
}

const renderFrame = (): void => {
  if (!renderer || !scene || !camera) return
  controls?.update()
  renderer.render(scene, camera)
}

function fitCamera(): boolean {
  if (!camera || !controls || !currentObject) return false

  const width = stage.clientWidth
  const height = stage.clientHeight
  if (width < 2 || height < 2) {
    fitPending = true
    return true
  }

  const box = new THREE.Box3().setFromObject(currentObject)
  if (box.isEmpty()) return false

  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const maxDimension = Math.max(size.x, size.y, size.z)
  if (!Number.isFinite(maxDimension) || maxDimension <= 1e-6) return false

  camera.aspect = width / height
  camera.updateProjectionMatrix()

  const verticalFov = (camera.fov * Math.PI) / 180
  const fitHeight = maxDimension / (2 * Math.tan(verticalFov / 2))
  const fitWidth = fitHeight / Math.max(camera.aspect, 0.0001)
  const distance = Math.max(fitHeight, fitWidth) * 1.35

  const direction = new THREE.Vector3(0.85, 0.55, 1).normalize()
  camera.position.copy(center).addScaledVector(direction, distance)
  camera.near = Math.max(distance / 1000, 0.0001)
  camera.far = distance * 50
  camera.lookAt(center)
  camera.updateProjectionMatrix()

  controls.target.copy(center)
  controls.minDistance = distance * 0.25
  controls.maxDistance = distance * 4
  controls.update()
  fitPending = false
  return true
}

function frameEnvironment(): void {
  if (!environment || !currentObject) return
  currentObject.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(currentObject)
  environment.frame(box)
}

function observeResize(): void {
  resizeObserver = new ResizeObserver(() => resize())
  resizeObserver.observe(stage)
  resize()
}

function resize(): void {
  if (!renderer || !camera) return
  const width = stage.clientWidth
  const height = stage.clientHeight
  if (width < 2 || height < 2) {
    fitPending = true
    return
  }

  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  if (fitPending) fitCamera()
}

function setSpin(value: boolean): void {
  autoRotate = value
  if (controls) controls.autoRotate = value
  spinButton.setAttribute('aria-pressed', String(value))
}

function setPhase(phase: PreviewPhase): void {
  app.dataset.phase = phase
  loadingMessage.hidden = phase !== 'loading'
  errorBox.hidden = phase !== 'error'
  emptyBox.hidden = phase !== 'empty'
  fallbackImage.hidden = phase !== 'fallback'
  canvas.hidden = phase !== 'ready'
  hintLine.hidden = phase !== 'ready'
  spinButton.disabled = phase !== 'ready'
  resetButton.disabled = phase !== 'ready'
  updateExportButtons()
}

function showFailure(asset: PolyforkAsset, error: unknown): void {
  console.warn(`[polyfork] preview failed for ${asset.id}`, error)
  renderer?.setAnimationLoop(null)
  clearCurrentObject()

  if (asset.thumbnail) {
    fallbackImage.alt = `${asset.title} preview image`
    fallbackImage.referrerPolicy = 'no-referrer'
    fallbackImage.src = asset.thumbnail
    setPhase('fallback')
    return
  }

  showError('The asset preview could not be rendered.')
}

function showError(message: string): void {
  errorMessage.textContent = message
  setPhase('error')
}

function showEmpty(): void {
  currentAsset = null
  renderSequence += 1
  paramsController?.abort()
  paramsController = null
  if (paramsRenderTimer !== undefined) {
    window.clearTimeout(paramsRenderTimer)
    paramsRenderTimer = undefined
  }
  paramsRenderSequence += 1
  paramSchema = null
  paramValues = {}
  paramsPhase = 'loading'
  paramsMessage = ''
  paramsRevision = 0
  app.dataset.params = '{}'
  app.dataset.paramsRevision = '0'
  renderer?.setAnimationLoop(null)
  clearCurrentObject()
  setExportStatus('')
  document.title = 'Asset Preview — Polyfork'
  titleLine.textContent = 'No asset selected'
  titleLine.title = ''
  idLine.textContent = ''
  metaLine.replaceChildren()
  app.dataset.assetId = ''
  setPhase('empty')
}

function clearCurrentObject(): void {
  if (!currentObject) return
  scene?.remove(currentObject)
  disposeObject3D(currentObject)
  currentObject = null
}

function renderMeta(asset: PolyforkAsset): void {
  const items = [classLabel(asset.class), `${formatTriangles(asset.triangles)} tris`]
  if (asset.hasSkeleton) items.push('Animated')
  else if (asset.hasRig) items.push('Rigged')
  if (asset.free) items.push('Free')
  if (asset.remixable) items.push('Remixable')
  if (asset.kit) items.push(`Kit: ${asset.kit}`)

  metaLine.replaceChildren(...items.map((item, index) => chip(item, index === 0)))
}

function chip(text: string, accent: boolean): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = accent ? 'chip is-accent' : 'chip'
  element.textContent = text
  return element
}

function classLabel(value: string): string {
  if (!value) return 'Asset'
  return CLASS_LABELS.get(value) ?? value.charAt(0).toUpperCase() + value.slice(1)
}

function formatTriangles(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 10_000) return `${numberFormat.format(Math.round(value / 1000))}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function dispose(): void {
  if (disposed) return
  disposed = true
  stopTheme?.()
  stopTheme = undefined
  renderSequence += 1
  paramsController?.abort()
  paramsController = null
  if (paramsRenderTimer !== undefined) {
    window.clearTimeout(paramsRenderTimer)
    paramsRenderTimer = undefined
  }
  resizeObserver?.disconnect()
  resizeObserver = null
  renderer?.setAnimationLoop(null)
  clearCurrentObject()
  environment?.dispose()
  environment = null
  controls?.dispose()
  renderer?.dispose()
  fallbackImage.removeAttribute('src')
  controls = null
  renderer = null
  camera = null
  scene = null
}

function showBootError(error: unknown): void {
  app.dataset.phase = 'error'
  app.hidden = true
  const box = document.getElementById('boot-error')
  const detail = document.getElementById('boot-error-detail')
  if (box) box.hidden = false
  if (detail) detail.textContent = error instanceof Error ? error.message : String(error)
  console.error('[polyfork] preview boot failed', error)
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`The Polyfork preview is missing #${id}.`)
  return element as T
}

void boot().catch(showBootError)

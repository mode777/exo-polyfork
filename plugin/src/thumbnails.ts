import { POLYFORK_ORIGIN, isSafeAssetId, type PolyforkAsset } from './api'

type ThreeNamespace = typeof import('three')
type Object3D = import('three').Object3D

const THUMBNAIL_WIDTH = 512
const THUMBNAIL_HEIGHT = 384
const MAX_CONCURRENT_RENDERS = 2
const MEMORY_CACHE_ENTRIES = 240
const CACHE_VERSION = 'v1-three-0.180.0'
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 300
const DB_NAME = 'exo-polyfork-thumbnails'
const DB_VERSION = 1
const DB_STORE = 'thumbs'

export type ThumbnailCacheMode = 'indexeddb' | 'memory'
export type ThumbnailListener = (blob: Blob | null) => void

interface PendingJob {
  assetId: string
  generation: number
  listeners: Set<ThumbnailListener>
  cancelled: boolean
}

interface CacheRecord {
  key: string
  blob: Blob
  savedAt: number
}

interface AssetModule {
  createAsset?: (params?: unknown) => unknown
  default?: unknown
}

/**
 * Renders missing thumbnails from the asset's parametric `.mjs` module through
 * a hidden WebGL canvas, then caches the result. Nothing here fetches a GLB:
 * createAsset() is the only asset source.
 *
 * The deployed plugin runs on the same origin as the Exo shell, so the shell
 * sandboxes it without origin storage. IndexedDB is still preferred when the
 * page has a storage-capable origin; otherwise the cache is in-memory for the
 * lifetime of the panel.
 */
export class ThumbnailService {
  private readonly canvas: HTMLCanvasElement
  private threePromise: Promise<ThreeNamespace> | null = null
  private renderer: import('three').WebGLRenderer | null = null
  private db: IDBDatabase | null = null
  private cacheMode: ThumbnailCacheMode = 'memory'
  private initialized = false
  private disposed = false
  private generation = 0
  private queue: PendingJob[] = []
  private jobs = new Map<string, PendingJob>()
  private memory = new Map<string, Blob>()
  private active = 0
  private writesSincePrune = 0
  private renderUnavailable = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  get storageMode(): ThumbnailCacheMode {
    return this.cacheMode
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    this.db = await openThumbnailDb()
    this.cacheMode = this.db ? 'indexeddb' : 'memory'
    if (this.db) {
      this.db.onversionchange = () => {
        this.db?.close()
        this.db = null
        this.cacheMode = 'memory'
      }
    }
    console.info(`[polyfork] thumbnail cache: ${this.cacheMode}`)
  }

  /**
   * Cancel work for the previous page. Active renders still finish and warm the
   * cache, but their listeners are not called.
   */
  beginPage(): number {
    this.generation += 1
    this.queue = []
    for (const job of this.jobs.values()) job.cancelled = true
    this.jobs.clear()
    return this.generation
  }

  ensure(asset: PolyforkAsset, generation: number, listener: ThumbnailListener): void {
    if (this.disposed || generation !== this.generation) return
    const key = cacheKey(asset.id)
    const cached = this.memory.get(key)
    if (cached) {
      listener(cached)
      return
    }

    const existing = this.jobs.get(key)
    if (existing) {
      existing.listeners.add(listener)
      return
    }

    const job: PendingJob = {
      assetId: asset.id,
      generation,
      listeners: new Set([listener]),
      cancelled: false,
    }
    this.jobs.set(key, job)
    this.queue.push(job)
    this.drain()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.queue = []
    for (const job of this.jobs.values()) job.cancelled = true
    this.jobs.clear()
    this.memory.clear()
    this.renderer?.dispose()
    this.renderer = null
    this.db?.close()
    this.db = null
  }

  private drain(): void {
    if (this.disposed) return
    while (this.active < MAX_CONCURRENT_RENDERS && this.queue.length > 0) {
      const job = this.queue.shift()
      if (!job) break
      this.active += 1
      void this.process(job).finally(() => {
        this.active -= 1
        this.drain()
      })
    }
  }

  private async process(job: PendingJob): Promise<void> {
    const key = cacheKey(job.assetId)
    let blob = this.memory.get(key) ?? null

    if (!blob && this.db) {
      blob = await this.readCache(key)
      if (blob) this.setMemory(key, blob)
    }

    if (!blob) {
      try {
        blob = await this.render(job.assetId)
      } catch (error) {
        console.warn(`[polyfork] thumbnail failed for ${job.assetId}`, error)
      }
      if (blob) {
        this.setMemory(key, blob)
        if (this.db) void this.writeCache(key, blob)
      }
    }

    if (this.jobs.get(key) === job) this.jobs.delete(key)
    if (job.cancelled || job.generation !== this.generation) return

    for (const listener of job.listeners) {
      try {
        listener(blob)
      } catch (error) {
        console.warn('[polyfork] thumbnail listener failed', error)
      }
    }
  }

  private setMemory(key: string, blob: Blob): void {
    this.memory.set(key, blob)
    if (this.memory.size <= MEMORY_CACHE_ENTRIES) return
    const oldest = this.memory.keys().next().value
    if (oldest !== undefined) this.memory.delete(oldest)
  }

  private getThree(): Promise<ThreeNamespace> {
    if (!this.threePromise) {
      this.threePromise = import('three').catch((error: unknown) => {
        this.threePromise = null
        throw error
      })
    }
    return this.threePromise
  }

  private async ensureRenderer(THREE: ThreeNamespace): Promise<import('three').WebGLRenderer> {
    if (this.renderer) return this.renderer
    if (this.renderUnavailable) throw new Error('WebGL is not available for thumbnail rendering.')

    let renderer: import('three').WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      })
    } catch (error) {
      this.renderUnavailable = true
      throw error
    }

    renderer.setPixelRatio(1)
    renderer.setSize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, false)
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    // Polyfork's palette is authored for no tone mapping; ACES darkens it.
    renderer.toneMapping = THREE.NoToneMapping

    this.canvas.addEventListener(
      'webglcontextlost',
      (event) => {
        event.preventDefault()
        this.renderUnavailable = true
        this.renderer = null
      },
      { once: true },
    )

    this.renderer = renderer
    return renderer
  }

  private async render(assetId: string): Promise<Blob> {
    if (!isSafeAssetId(assetId)) throw new Error('Invalid asset id.')
    if (this.renderUnavailable) throw new Error('WebGL is not available for thumbnail rendering.')

    const THREE = await this.getThree()
    const renderer = await this.ensureRenderer(THREE)
    const module = (await import(
      /* @vite-ignore */ `${POLYFORK_ORIGIN}/cdn/${assetId}.mjs`
    )) as AssetModule

    const factory =
      typeof module.createAsset === 'function'
        ? module.createAsset
        : typeof module.default === 'function'
          ? (module.default as (params?: unknown) => unknown)
          : null
    if (!factory) throw new Error('The asset module has no createAsset export.')

    const object = factory()
    if (!isObject3D(object)) throw new Error('createAsset() did not return an Object3D.')

    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x59636f, 1.5))

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.9)
    keyLight.position.set(4, 7, 5)
    scene.add(keyLight)

    const fillLight = new THREE.DirectionalLight(0xbcd2ff, 0.55)
    fillLight.position.set(-5, 2, -4)
    scene.add(fillLight)

    try {
      scene.add(object)
      object.updateMatrixWorld(true)

      const box = new THREE.Box3().setFromObject(object)
      if (box.isEmpty()) throw new Error('The asset has no measurable bounds.')

      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const maxDimension = Math.max(size.x, size.y, size.z)
      if (!Number.isFinite(maxDimension) || maxDimension <= 1e-6) {
        throw new Error('The asset has no measurable bounds.')
      }

      const camera = new THREE.PerspectiveCamera(
        30,
        THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT,
        0.001,
        100000,
      )
      const verticalFov = (camera.fov * Math.PI) / 180
      const fitHeight = maxDimension / (2 * Math.tan(verticalFov / 2))
      const fitWidth = fitHeight / camera.aspect
      const distance = Math.max(fitHeight, fitWidth) * 1.32

      const direction = new THREE.Vector3(0.9, 0.62, 1).normalize()
      camera.position.copy(center).addScaledVector(direction, distance)
      camera.near = Math.max(distance / 1000, 0.001)
      camera.far = distance * 20
      camera.lookAt(center)

      renderer.render(scene, camera)
      return await canvasToBlob(this.canvas)
    } finally {
      disposeObject3D(object)
      scene.clear()
    }
  }

  private async readCache(key: string): Promise<Blob | null> {
    const db = this.db
    if (!db) return null
    try {
      const tx = db.transaction(DB_STORE, 'readonly')
      const record = await requestToPromise(tx.objectStore(DB_STORE).get(key))
      if (!isCacheRecord(record)) return null
      if (Date.now() - record.savedAt > CACHE_TTL_MS) {
        void this.deleteCache(key)
        return null
      }
      return record.blob
    } catch {
      return null
    }
  }

  private async writeCache(key: string, blob: Blob): Promise<void> {
    const db = this.db
    if (!db) return
    try {
      const tx = db.transaction(DB_STORE, 'readwrite')
      const record: CacheRecord = { key, blob, savedAt: Date.now() }
      tx.objectStore(DB_STORE).put(record)
      await transactionDone(tx)
      this.writesSincePrune += 1
      if (this.writesSincePrune >= 20) {
        this.writesSincePrune = 0
        this.prune()
      }
    } catch {
      // A full or blocked storage area must never break browsing.
    }
  }

  private async deleteCache(key: string): Promise<void> {
    const db = this.db
    if (!db) return
    try {
      const tx = db.transaction(DB_STORE, 'readwrite')
      tx.objectStore(DB_STORE).delete(key)
      await transactionDone(tx)
    } catch {
      // Best effort.
    }
  }

  private prune(): void {
    const db = this.db
    if (!db) return
    try {
      const tx = db.transaction(DB_STORE, 'readwrite')
      const store = tx.objectStore(DB_STORE)
      const countRequest = store.count()
      countRequest.onsuccess = () => {
        let remove = countRequest.result - MAX_CACHE_ENTRIES
        if (remove <= 0) return
        const cursorRequest = store.index('savedAt').openCursor()
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result
          if (!cursor || remove <= 0) return
          cursor.delete()
          remove -= 1
          cursor.continue()
        }
      }
    } catch {
      // Best effort.
    }
  }
}

function cacheKey(assetId: string): string {
  return `${CACHE_VERSION}:${assetId}`
}

function isObject3D(value: unknown): value is Object3D {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isObject3D?: unknown }).isObject3D === true
  )
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('The thumbnail canvas produced no image.'))
      },
      'image/webp',
      0.9,
    )
  })
}

function disposeObject3D(root: Object3D): void {
  interface Disposable {
    dispose?: () => void
  }
  interface MaterialLike extends Disposable {
    [key: string]: unknown
  }

  const geometries = new Set<Disposable>()
  const materials = new Set<MaterialLike>()

  root.traverse((node) => {
    const mesh = node as unknown as {
      geometry?: Disposable
      material?: MaterialLike | MaterialLike[]
    }
    if (mesh.geometry) geometries.add(mesh.geometry)
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) materials.add(material)
    } else if (mesh.material) {
      materials.add(mesh.material)
    }
  })

  for (const geometry of geometries) geometry.dispose?.()
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value && typeof value === 'object' && (value as { isTexture?: unknown }).isTexture === true) {
        ;(value as Disposable).dispose?.()
      }
    }
    material.dispose?.()
  }
}

function openThumbnailDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: IDBDatabase | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let request: IDBOpenDBRequest
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        finish(null)
        return
      }
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      finish(null)
      return
    }

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DB_STORE)) {
        const store = db.createObjectStore(DB_STORE, { keyPath: 'key' })
        store.createIndex('savedAt', 'savedAt')
      }
    }
    request.onsuccess = () => {
      const db = request.result
      if (settled) {
        db.close()
        return
      }
      finish(db)
    }
    request.onerror = () => finish(null)
    request.onblocked = () => finish(null)
  })
}

function isCacheRecord(value: unknown): value is CacheRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<CacheRecord>
  return (
    typeof record.key === 'string' &&
    typeof record.savedAt === 'number' &&
    record.blob instanceof Blob
  )
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'))
  })
}

import type { Object3D } from 'three'
import { buildAssetModuleUrl, isSafeAssetId } from './api'

interface AssetModule {
  createAsset?: (params?: unknown) => unknown
  default?: unknown
}

/**
 * Import an asset's parametric module and call `createAsset(params)`. A GLB is
 * never fetched: the `.mjs` module is the only asset source for both the
 * thumbnail canvas and the content-view preview.
 */
export async function loadAssetObject(
  assetId: string,
  params?: Record<string, unknown>,
): Promise<Object3D> {
  if (!isSafeAssetId(assetId)) throw new Error('Invalid asset id.')

  const module = (await import(
    /* @vite-ignore */ buildAssetModuleUrl(assetId)
  )) as AssetModule
  const factory =
    typeof module.createAsset === 'function'
      ? module.createAsset
      : typeof module.default === 'function'
        ? (module.default as (params?: unknown) => unknown)
        : null
  if (!factory) throw new Error('The asset module has no createAsset export.')

  const object = params === undefined ? factory() : factory(params)
  if (!isObject3D(object)) throw new Error('createAsset() did not return an Object3D.')
  return object
}

export function isObject3D(value: unknown): value is Object3D {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isObject3D?: unknown }).isObject3D === true
  )
}

/** Release the geometries, textures and materials of a created asset. */
export function disposeObject3D(root: Object3D): void {
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
      if (
        value &&
        typeof value === 'object' &&
        (value as { isTexture?: unknown }).isTexture === true
      ) {
        ;(value as Disposable).dispose?.()
      }
    }
    material.dispose?.()
  }
}

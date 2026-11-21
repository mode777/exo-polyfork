import * as THREE from 'three'

/**
 * Position of the sun relative to the asset. The same direction drives the
 * directional light and the glow baked into the environment map, so highlights
 * and the visible light agree with each other.
 */
const SUN_DIRECTION = new THREE.Vector3(-0.7, 1.05, 0.25).normalize()
const SKY_WIDTH = 1024
const SKY_HEIGHT = 512
const SHADOW_MAP_SIZE = 2048
const GROUND_RADIUS = 4
const GROUND_ALPHA_SIZE = 256

/**
 * A daylight preview stage: a procedural sky baked into an equirectangular
 * environment map provides soft image-based lighting (the sky above, warm
 * bounce below), while a shadow-catching ground disc and a sun directional
 * light give the asset a place to stand.
 */
export class PreviewEnvironment {
  readonly sun: THREE.DirectionalLight

  private readonly scene: THREE.Scene
  private readonly environmentTarget: THREE.WebGLRenderTarget
  private readonly ground: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>
  private readonly groundAlpha: THREE.CanvasTexture

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.scene = scene

    const sky = createSkyTexture()
    const generator = new THREE.PMREMGenerator(renderer)
    generator.compileEquirectangularShader()
    this.environmentTarget = generator.fromEquirectangular(sky)
    generator.dispose()
    sky.dispose()

    scene.environment = this.environmentTarget.texture
    scene.environmentIntensity = 0.55

    this.sun = new THREE.DirectionalLight(0xfff2df, 2.6)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
    this.sun.shadow.bias = -0.0002
    this.sun.shadow.radius = 2.5
    scene.add(this.sun)
    scene.add(this.sun.target)

    this.groundAlpha = createGroundAlphaTexture()
    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(1, 96),
      new THREE.MeshStandardMaterial({
        color: 0x9c9384,
        roughness: 0.95,
        metalness: 0,
        alphaMap: this.groundAlpha,
        transparent: true,
      }),
    )
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    scene.add(this.ground)
  }

  /** Fit the ground, sun and shadow frustum to the current asset bounds. */
  frame(box: THREE.Box3): void {
    if (box.isEmpty()) return
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const maxDimension = Math.max(size.x, size.y, size.z)
    if (!Number.isFinite(maxDimension) || maxDimension <= 1e-6) return

    this.ground.scale.setScalar(maxDimension * GROUND_RADIUS)
    this.ground.position.set(center.x, box.min.y - maxDimension * 0.004, center.z)

    this.sun.position.copy(center).addScaledVector(SUN_DIRECTION, maxDimension * 4)
    this.sun.target.position.copy(center)
    this.sun.target.updateMatrixWorld()

    const radius = box.getBoundingSphere(new THREE.Sphere()).radius
    const extent = Math.max(radius * 1.25, maxDimension * 0.1)
    const shadowCamera = this.sun.shadow.camera
    shadowCamera.left = -extent
    shadowCamera.right = extent
    shadowCamera.top = extent
    shadowCamera.bottom = -extent
    shadowCamera.near = Math.max(maxDimension * 0.05, 1e-5)
    shadowCamera.far = maxDimension * 12
    shadowCamera.updateProjectionMatrix()
    this.sun.shadow.normalBias = maxDimension * 0.01
  }

  dispose(): void {
    this.scene.environment = null
    this.sun.removeFromParent()
    this.sun.target.removeFromParent()
    this.sun.shadow.dispose()
    this.ground.removeFromParent()
    this.ground.geometry.dispose()
    this.ground.material.dispose()
    this.groundAlpha.dispose()
    this.environmentTarget.dispose()
  }
}

/** Assets are created without shadow flags; opt every mesh into the stage. */
export function enableAssetShadows(root: THREE.Object3D): void {
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) {
      node.castShadow = true
      node.receiveShadow = true
    }
  })
}

function createSkyTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = SKY_WIDTH
  canvas.height = SKY_HEIGHT
  const context = canvas.getContext('2d')
  if (!context) throw new Error('A 2D canvas is required for the preview sky.')

  const sky = context.createLinearGradient(0, 0, 0, canvas.height)
  sky.addColorStop(0, '#3f7fbf')
  sky.addColorStop(0.28, '#77a8d8')
  sky.addColorStop(0.45, '#c4d9ee')
  sky.addColorStop(0.495, '#eef0e8')
  sky.addColorStop(0.5, '#e8e2d2')
  sky.addColorStop(0.56, '#a99f8b')
  sky.addColorStop(0.78, '#6d6657')
  sky.addColorStop(1, '#474337')
  context.fillStyle = sky
  context.fillRect(0, 0, canvas.width, canvas.height)

  const u = Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x) / (Math.PI * 2) + 0.5
  const v =
    Math.asin(THREE.MathUtils.clamp(SUN_DIRECTION.y, -1, 1)) / Math.PI + 0.5
  const sunX = u * canvas.width
  const sunY = (1 - v) * canvas.height

  const glow = context.createRadialGradient(sunX, sunY, 0, sunX, sunY, canvas.height * 0.42)
  glow.addColorStop(0, 'rgba(255, 252, 235, 1)')
  glow.addColorStop(0.035, 'rgba(255, 248, 214, 0.95)')
  glow.addColorStop(0.12, 'rgba(255, 235, 190, 0.45)')
  glow.addColorStop(0.4, 'rgba(255, 226, 178, 0.12)')
  glow.addColorStop(1, 'rgba(255, 226, 178, 0)')
  context.globalCompositeOperation = 'lighter'
  context.fillStyle = glow
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.globalCompositeOperation = 'source-over'

  const texture = new THREE.CanvasTexture(canvas)
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * White in the middle, black at the rim, so the ground disc fades into the
 * themed stage backdrop instead of ending in a hard circle.
 */
function createGroundAlphaTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = GROUND_ALPHA_SIZE
  canvas.height = GROUND_ALPHA_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('A 2D canvas is required for the preview ground.')

  context.fillStyle = '#000000'
  context.fillRect(0, 0, canvas.width, canvas.height)

  const center = canvas.width / 2
  const fade = context.createRadialGradient(center, center, 0, center, center, center)
  fade.addColorStop(0, '#ffffff')
  fade.addColorStop(0.3, '#cfcfcf')
  fade.addColorStop(0.6, '#808080')
  fade.addColorStop(0.85, '#2d2d2d')
  fade.addColorStop(1, '#000000')
  context.fillStyle = fade
  context.fillRect(0, 0, canvas.width, canvas.height)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.NoColorSpace
  return texture
}

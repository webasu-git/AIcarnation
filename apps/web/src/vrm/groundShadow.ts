import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'

/**
 * 足元のやわらかい丸い影。背景の前に置いたアバターが浮いて見えないよう、地面に立っているように見せる。
 * 大きさは腰の高さ（脚の長さ）と肩幅から決めるので、体型の違うモデルでもそれなりの大きさになる。腰の位置を毎コマ追いかける
 */
export class GroundShadow {
  private readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private vrm: VRM | null = null
  private strength = 0.5
  private readonly hips = new THREE.Vector3()

  constructor(scene: THREE.Scene) {
    const material = new THREE.MeshBasicMaterial({
      map: shadowTexture(),
      color: 0x000000,
      transparent: true,
      depthWrite: false,
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
    this.mesh.rotation.x = -Math.PI / 2
    // アバターより先に描き、体に重ならないようにする
    this.mesh.renderOrder = -1
    this.mesh.visible = false
    scene.add(this.mesh)
  }

  attach(vrm: VRM | null): void {
    this.vrm = vrm
    if (!vrm) {
      this.mesh.visible = false
      return
    }
    vrm.scene.updateMatrixWorld(true)
    const size = shadowSize(vrm)
    this.mesh.scale.set(size.width, size.depth, 1)
    this.apply()
  }

  /** 濃さ（0〜1。0 で出さない） */
  setStrength(strength: number): void {
    this.strength = strength
    this.apply()
  }

  /** 腰の真下に置く。地面はモデルの足元（VRM はモデルの原点が足元） */
  update(): void {
    const hips = this.vrm?.humanoid.getNormalizedBoneNode('hips')
    if (!this.vrm || !hips) return
    hips.getWorldPosition(this.hips)
    this.mesh.position.set(this.hips.x, this.vrm.scene.position.y + 0.002, this.hips.z)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.mesh.material.map?.dispose()
    this.mesh.material.dispose()
  }

  private apply(): void {
    this.mesh.material.opacity = this.strength
    this.mesh.visible = this.vrm !== null && this.strength > 0
  }
}

/** 影の大きさ（m）。肩幅の 1.6 倍・脚の長さの 0.45 倍のうち大きいほうを横幅に、奥行きはその 0.6 倍 */
export function shadowWidth(shoulderWidth: number, hipsHeight: number): number {
  return Math.max(shoulderWidth * 1.6, hipsHeight * 0.45, 0.2)
}

function shadowSize(vrm: VRM): { width: number; depth: number } {
  const pos = (name: 'hips' | 'leftUpperArm' | 'rightUpperArm') =>
    vrm.humanoid.getNormalizedBoneNode(name)?.getWorldPosition(new THREE.Vector3()) ?? null
  const hips = pos('hips')
  const left = pos('leftUpperArm')
  const right = pos('rightUpperArm')
  const hipsHeight = hips ? hips.y - vrm.scene.position.y : 0.8
  const shoulder = left && right ? left.distanceTo(right) : 0.3
  const width = shadowWidth(shoulder, hipsHeight)
  return { width, depth: width * 0.6 }
}

/** 真ん中が濃く、外へなめらかに薄くなる丸 */
function shadowTexture(): THREE.Texture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.6)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  // 色は material.color（黒）、濃さは透明度で出すので、白の明るさを透明度として使う
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

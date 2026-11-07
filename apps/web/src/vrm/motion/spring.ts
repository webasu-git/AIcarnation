import * as THREE from 'three'
import type { VRMHumanBoneName } from '@pixiv/three-vrm'

/**
 * 関節ごとのばね（動きのブラッシュアップ 案C）。
 * 計算した目標の回転へ、回転のまま（球面で）ばねのように近づける。
 * - 部位ごとに速さを変える：肩が先に動き、肘・手首が少しずつ遅れてついてくる（追従と遅れ）
 * - 減衰を弱めにした部位は、止まるときに少し行き過ぎて戻る（フォロースルー）
 * どの動き（土台・姿勢・身ぶり・手ぶり）も最後にここを通るので、全体の機械的な感じが減る。
 */

/** ばねの性質：f は固有振動数（Hz。大きいほど速く追う）、zeta は減衰比（1 未満で少し行き過ぎる） */
export interface SpringParams {
  f: number
  zeta: number
}

const TORSO: SpringParams = { f: 3.2, zeta: 0.9 }
const HEAD: SpringParams = { f: 4.2, zeta: 0.85 }
const SHOULDER: SpringParams = { f: 3.6, zeta: 0.8 }
const UPPER_ARM: SpringParams = { f: 2.8, zeta: 0.72 }
const LOWER_ARM: SpringParams = { f: 2.3, zeta: 0.66 }
const HAND: SpringParams = { f: 2.0, zeta: 0.62 }
const FINGER: SpringParams = { f: 3.4, zeta: 0.8 }
const LEG: SpringParams = { f: 4.0, zeta: 0.9 }

/** ボーンの名前から、ばねの性質を決める */
export function springFor(bone: VRMHumanBoneName): SpringParams {
  if (bone === 'neck' || bone === 'head') return HEAD
  if (bone.endsWith('Shoulder')) return SHOULDER
  if (bone.endsWith('UpperArm')) return UPPER_ARM
  if (bone.endsWith('LowerArm')) return LOWER_ARM
  if (bone.endsWith('Hand')) return HAND
  if (/(Thumb|Index|Middle|Ring|Little)/.test(bone)) return FINGER
  if (/(UpperLeg|LowerLeg|Foot|Toes)/.test(bone)) return LEG
  return TORSO
}

/** 計算を安定させるための、1 回の計算の時間の上限（秒） */
const MAX_SUBSTEP = 1 / 120

interface State {
  q: THREE.Quaternion
  /** 角速度（軸 × 速さ、ラジアン/秒） */
  w: THREE.Vector3
}

const tmpQ = new THREE.Quaternion()
const tmpV = new THREE.Vector3()

/** 回転の差（from から to へ）を、軸 × 角度のベクトルにする */
function rotationVector(from: THREE.Quaternion, to: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  tmpQ.copy(from).invert().premultiply(to) // to * from^-1
  // 遠回りしないよう、短い方の回転にそろえる
  if (tmpQ.w < 0) tmpQ.set(-tmpQ.x, -tmpQ.y, -tmpQ.z, -tmpQ.w)
  const s = Math.sqrt(1 - Math.min(1, tmpQ.w * tmpQ.w))
  const angle = 2 * Math.acos(Math.min(1, tmpQ.w))
  if (s < 1e-6) return out.set(0, 0, 0)
  return out.set((tmpQ.x / s) * angle, (tmpQ.y / s) * angle, (tmpQ.z / s) * angle)
}

/** 回転 q を、角速度 w で dt 秒進める */
function integrate(q: THREE.Quaternion, w: THREE.Vector3, dt: number): void {
  const angle = w.length() * dt
  if (angle < 1e-9) return
  tmpV.copy(w).normalize()
  tmpQ.setFromAxisAngle(tmpV, angle)
  q.premultiply(tmpQ).normalize()
}

export class PoseSpring {
  private readonly states = new Map<VRMHumanBoneName, State>()

  /**
   * ボーンの回転を目標へ dt 秒ぶん近づけて返す。初めて見るボーンは目標にそのまま合わせる。
   * weight を下げると、ばねを弱めて目標にすぐ合わせる（1 で通常）
   */
  step(bone: VRMHumanBoneName, target: THREE.Quaternion, dt: number): THREE.Quaternion {
    let state = this.states.get(bone)
    if (!state) {
      state = { q: target.clone(), w: new THREE.Vector3() }
      this.states.set(bone, state)
      return state.q
    }
    const { f, zeta } = springFor(bone)
    const omega = 2 * Math.PI * f
    const k = omega * omega
    const c = 2 * zeta * omega
    let remaining = dt
    const diff = new THREE.Vector3()
    while (remaining > 1e-6) {
      const h = Math.min(MAX_SUBSTEP, remaining)
      rotationVector(state.q, target, diff)
      // 半陰的オイラー法：速度を先に更新してから回転を進める
      state.w.addScaledVector(diff, k * h).addScaledVector(state.w, -c * h)
      integrate(state.q, state.w, h)
      remaining -= h
    }
    return state.q
  }

  /** 覚えている状態を捨てる（モデルを読み替えたときなど） */
  reset(): void {
    this.states.clear()
  }
}

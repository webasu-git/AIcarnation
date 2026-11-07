import type { VRMHumanBoneName } from '@pixiv/three-vrm'

/**
 * ボーンごとの回転（ラジアン、VRM 1.0 の向き。x・y・z の順）。
 * 層ごとに作って足し合わせる（角度が小さいので、足し算で十分自然に重なる）
 */
export type Rotation = [number, number, number]
export type Pose = Partial<Record<VRMHumanBoneName, Rotation>>

/** pose のボーンに回転を足す（無ければ作る） */
export function addRotation(pose: Pose, bone: VRMHumanBoneName, x: number, y: number, z: number): void {
  const r = pose[bone]
  if (r) {
    r[0] += x
    r[1] += y
    r[2] += z
  } else {
    pose[bone] = [x, y, z]
  }
}

/** from のすべてのボーンを、weight を掛けて into に足す */
export function addPose(into: Pose, from: Pose, weight = 1): void {
  for (const [bone, r] of Object.entries(from) as [VRMHumanBoneName, Rotation][]) {
    addRotation(into, bone, r[0] * weight, r[1] * weight, r[2] * weight)
  }
}

/** 左右で回転の向きが逆になる軸（y・z）をそろえるときに使う */
export type Side = 'left' | 'right'
export const SIDES: readonly Side[] = ['left', 'right']
export function sideSign(side: Side): number {
  return side === 'left' ? 1 : -1
}

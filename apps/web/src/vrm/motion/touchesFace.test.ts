import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { VRM } from '@pixiv/three-vrm'
import { touchesFace } from './clips'

// 顔が +Z を向く、右腕だけの簡単な骨格（位置は親からの差）
const REST: Record<string, [number, number, number]> = {
  hips: [0, 1, 0],
  spine: [0, 0.1, 0],
  chest: [0, 0.1, 0],
  neck: [0, 0.2, 0],
  head: [0, 0.1, 0],
  rightShoulder: [-0.05, 0.15, 0],
  rightUpperArm: [-0.1, 0, 0],
  rightLowerArm: [-0.25, 0, 0],
  rightHand: [-0.22, 0, 0],
}

function fakeVrm(): VRM {
  const humanBones = Object.fromEntries(Object.keys(REST).map((b) => [b, { node: new THREE.Object3D() }]))
  return {
    humanoid: {
      humanBones,
      normalizedRestPose: Object.fromEntries(Object.entries(REST).map(([b, p]) => [b, { position: p }])),
      getNormalizedBoneNode: (b: string) => (REST[b] ? { name: `n_${b}` } : null),
    },
  } as unknown as VRM
}

function clip(rotations: Record<string, THREE.Quaternion>): THREE.AnimationClip {
  const tracks = Object.entries(rotations).map(
    ([b, q]) => new THREE.QuaternionKeyframeTrack(`n_${b}.quaternion`, [0, 1], [...q.toArray(), ...q.toArray()]),
  )
  return new THREE.AnimationClip('test', 1, tracks)
}

const aroundZ = (deg: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(deg))

describe('touchesFace（顔に手を当てる動きか）', () => {
  it('腕を下ろしたまま（基本の姿勢）なら、顔に触れない', () => {
    expect(touchesFace(clip({ rightUpperArm: new THREE.Quaternion() }), fakeVrm())).toBe(false)
  })

  it('ひじを曲げて手を頭の横まで上げると、顔に触れる', () => {
    // 上腕を真上へ、前腕をさらに曲げて、手を頭のすぐ横へ
    expect(touchesFace(clip({ rightUpperArm: aroundZ(-90), rightLowerArm: aroundZ(-90) }), fakeVrm())).toBe(true)
  })

  it('腕を真上へ伸ばしただけ（手が頭から離れている）なら、顔に触れない', () => {
    expect(touchesFace(clip({ rightUpperArm: aroundZ(-90) }), fakeVrm())).toBe(false)
  })
})

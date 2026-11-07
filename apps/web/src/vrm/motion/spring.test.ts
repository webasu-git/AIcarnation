import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { PoseSpring } from './spring'

/** 回転 q の、x 軸まわりの角度（ラジアン） */
function angleOf(q: THREE.Quaternion): number {
  return new THREE.Euler().setFromQuaternion(q).x
}

function run(spring: PoseSpring, bone: Parameters<PoseSpring['step']>[0], target: THREE.Quaternion, seconds: number) {
  const angles: number[] = []
  for (let t = 0; t < seconds; t += 1 / 60) angles.push(angleOf(spring.step(bone, target, 1 / 60)))
  return angles
}

describe('PoseSpring（関節ごとのばね）', () => {
  const start = new THREE.Quaternion()
  const target = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.8)

  it('初めて見るボーンは目標にそのまま合わせる', () => {
    const spring = new PoseSpring()
    expect(angleOf(spring.step('head', target, 1 / 60))).toBeCloseTo(0.8)
  })

  it('目標へなめらかに近づき、最後は目標に落ち着く', () => {
    const spring = new PoseSpring()
    spring.step('leftUpperArm', start, 0)
    const angles = run(spring, 'leftUpperArm', target, 2)
    expect(angles[1]).toBeLessThan(0.2)
    expect(angles.at(-1)).toBeCloseTo(0.8, 2)
  })

  it('肘・手首は肩より遅れてついてきて、少し行き過ぎて戻る', () => {
    const spring = new PoseSpring()
    for (const bone of ['leftUpperArm', 'leftLowerArm', 'leftHand'] as const) spring.step(bone, start, 0)
    const upper = run(spring, 'leftUpperArm', target, 2)
    const lower = run(spring, 'leftLowerArm', target, 2)
    const hand = run(spring, 'leftHand', target, 2)
    // 0.1 秒後の進み具合：肩 > 肘 > 手首
    const i = 6
    expect(upper[i]).toBeGreaterThan(lower[i] ?? 0)
    expect(lower[i]).toBeGreaterThan(hand[i] ?? 0)
    // 手首は一度、目標を少し行き過ぎる
    expect(Math.max(...hand)).toBeGreaterThan(0.8)
    expect(Math.max(...hand)).toBeLessThan(0.95)
  })

  it('大きく時間が飛んでも、暴れずに落ち着く', () => {
    const spring = new PoseSpring()
    spring.step('rightHand', start, 0)
    const q = spring.step('rightHand', target, 0.5)
    expect(Math.abs(angleOf(q))).toBeLessThan(1.2)
  })
})

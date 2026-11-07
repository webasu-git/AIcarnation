import { describe, expect, it } from 'vitest'
import type { RigInfo } from '../rig'
import { BaseIdle } from './base'
import { Noise1D } from './noise'
import type { Pose } from './pose'

const RIG: RigInfo = {
  hasFingers: true,
  hasThumbs: true,
  hasUpperChest: false,
  hasChest: true,
  hasShoulders: true,
  hasWink: false,
  hasSpringBones: false,
  customExpressions: [],
  version: '1',
}

/** seconds 秒ぶん動かし、各フレームのポーズを返す */
function run(base: BaseIdle, seconds: number, step = 1 / 30): Pose[] {
  const poses: Pose[] = []
  for (let t = 0; t < seconds; t += step) {
    const pose: Pose = {}
    base.update(step, pose)
    poses.push(pose)
  }
  return poses
}

describe('Noise1D（なめらかな乱数）', () => {
  it('同じ種なら同じ揺れ、値はおよそ -1〜1 で、なめらかに変わる', () => {
    const a = new Noise1D(7)
    const b = new Noise1D(7)
    let prev = a.at(0)
    for (let t = 0; t < 50; t += 0.05) {
      const v = a.at(t)
      expect(v).toBe(b.at(t))
      expect(Math.abs(v)).toBeLessThanOrEqual(1)
      expect(Math.abs(v - prev)).toBeLessThan(0.2)
      prev = v
    }
  })
})

describe('BaseIdle（土台の待機）', () => {
  it('重心を左右に乗せ替え、腰の傾きが両側に振れる', () => {
    const tilts = run(new BaseIdle(RIG), 60).map((p) => p.hips?.[2] ?? 0)
    expect(Math.max(...tilts)).toBeGreaterThan(0.01)
    expect(Math.min(...tilts)).toBeLessThan(-0.01)
  })

  it('腕は下ろした姿勢のまま揺らさない（腕が体や服にめり込まないよう）', () => {
    const arms = run(new BaseIdle(RIG), 20).map((p) => p.leftUpperArm?.[2] ?? 0)
    for (const z of arms) expect(z).toBeLessThan(-1)
    expect(new Set(arms.map((z) => z.toFixed(4))).size).toBe(1)
  })

  it('指のボーンがあるモデルだけ指を曲げる', () => {
    const [withFingers] = run(new BaseIdle(RIG), 0.05)
    const [without] = run(new BaseIdle({ ...RIG, hasFingers: false, hasThumbs: false }), 0.05)
    expect(withFingers?.leftIndexProximal).toBeDefined()
    expect(without?.leftIndexProximal).toBeUndefined()
  })
})

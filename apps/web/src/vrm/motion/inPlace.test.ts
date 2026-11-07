import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { limitHipsTravel, limitHipsYaw, limitSideLean, softLimit } from './inPlace'

const Y = new THREE.Vector3(0, 1, 0)

/** 回転の、縦軸まわりの角度 */
function yawOf(values: Float32Array, i = 0): number {
  const q = new THREE.Quaternion().fromArray(values, i * 4)
  const twist = new THREE.Quaternion(0, q.y, 0, q.w).normalize()
  return 2 * Math.atan2(twist.y, twist.w)
}

describe('softLimit（柔らかい上限）', () => {
  it('小さい値はほぼそのまま、大きい値は上限を超えない', () => {
    expect(softLimit(0.01, 0.1)).toBeCloseTo(0.01, 3)
    expect(softLimit(10, 0.1)).toBeLessThanOrEqual(0.1)
    expect(softLimit(-10, 0.1)).toBeGreaterThanOrEqual(-0.1)
  })
})

describe('limitHipsTravel（腰の前後左右の動きを抑える）', () => {
  const rest = new THREE.Vector3(0, 0.9, 0)

  it('大きく踏み出しても上限の中にとどまり、向きは変えない。上下は抑えない', () => {
    const values = new Float32Array([0, 0.9, 0, 0.3, 0.6, 0.4])
    limitHipsTravel(values, rest, 0.05)
    const d = Math.hypot(values[3]!, values[5]!)
    expect(d).toBeLessThanOrEqual(0.05 + 1e-6)
    expect(values[3]! / values[5]!).toBeCloseTo(0.3 / 0.4, 4)
    expect(values[4]).toBeCloseTo(0.6)
  })

  it('小さな揺れは、ほぼそのまま残す', () => {
    const values = new Float32Array([0.005, 0.9, -0.003])
    limitHipsTravel(values, rest, 0.05)
    expect(values[0]).toBeCloseTo(0.005, 4)
    expect(values[2]).toBeCloseTo(-0.003, 4)
  })
})

describe('limitHipsYaw（体の向きを抑える）', () => {
  it('体ごと横を向いても上限の中にとどまり、前後の傾きは残す', () => {
    const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3)
    const turned = tilt.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Y, 1.4))
    const values = new Float32Array(turned.toArray())
    limitHipsYaw(values, 0.45)
    expect(Math.abs(yawOf(values))).toBeLessThanOrEqual(0.45 + 1e-5)
    // 傾き（ひねりを除いた部分）は変わらない
    const q = new THREE.Quaternion().fromArray(values)
    const twist = new THREE.Quaternion(0, q.y, 0, q.w).normalize()
    const swing = q.clone().multiply(twist.invert())
    expect(swing.angleTo(tilt)).toBeLessThan(1e-4)
  })

  it('小さなひねりは、ほぼそのまま残す', () => {
    const values = new Float32Array(new THREE.Quaternion().setFromAxisAngle(Y, 0.05).toArray())
    limitHipsYaw(values, 0.45)
    expect(yawOf(values)).toBeCloseTo(0.05, 3)
  })

  it('半回転より大きな回転も、近い向きへ抑える', () => {
    const values = new Float32Array(new THREE.Quaternion().setFromAxisAngle(Y, -2.8).toArray())
    limitHipsYaw(values, 0.45)
    expect(Math.abs(yawOf(values))).toBeLessThanOrEqual(0.45 + 1e-5)
  })
})

describe('limitSideLean（横への傾きを抑える）', () => {
  it('大きく横へ傾いても上限の中にとどまり、前への曲げと向きは残す', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.2, 0.6, 'YXZ'))
    const values = new Float32Array(q.toArray())
    limitSideLean(values, 0.15)
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(values), 'YXZ')
    expect(Math.abs(e.z)).toBeLessThanOrEqual(0.15 + 1e-5)
    expect(e.x).toBeCloseTo(0.4, 4)
    expect(e.y).toBeCloseTo(0.2, 4)
  })

  it('小さな傾きは、ほぼそのまま残す', () => {
    const values = new Float32Array(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.03, 'YXZ')).toArray())
    limitSideLean(values, 0.15)
    expect(new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(values), 'YXZ').z).toBeCloseTo(0.03, 3)
  })
})

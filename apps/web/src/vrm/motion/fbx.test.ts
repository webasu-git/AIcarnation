import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { isFbx, parseFbxMotion } from './fbx'
import { parseMotion } from './clips'
import { FIXTURE_MOTION, makeTestFbx } from './fbxFixture'
import { makeTestVrma } from './vrmaFixture'

/** トラックの最後のキーの回転 */
function lastQuat(track: THREE.KeyframeTrack | undefined): THREE.Quaternion {
  if (!track) throw new Error('トラックがありません')
  return new THREE.Quaternion().fromArray(track.values, track.values.length - 4)
}

function angleBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
  return a.angleTo(b)
}

describe('parseFbxMotion（Mixamo の FBX の読み替え）', () => {
  it('ボーンの向きの付け方が違う骨格でも、VRM の正規化した回転に直す', () => {
    const animation = parseFbxMotion(makeTestFbx())
    expect(animation.duration).toBeCloseTo(FIXTURE_MOTION.duration)
    const rotation = animation.humanoidTracks.rotation
    expect([...rotation.keys()].sort()).toEqual(['leftUpperArm', 'spine'])
    expect(angleBetween(lastQuat(rotation.get('spine')), FIXTURE_MOTION.spine)).toBeLessThan(1e-3)
    expect(angleBetween(lastQuat(rotation.get('leftUpperArm')), FIXTURE_MOTION.leftUpperArm)).toBeLessThan(1e-3)
    // 始めは回転なし
    const first = new THREE.Quaternion().fromArray(rotation.get('leftUpperArm')!.values, 0)
    expect(angleBetween(first, new THREE.Quaternion())).toBeLessThan(1e-3)
  })

  it('腰の位置は世界の座標（m）で、基本の腰の高さもそろえる', () => {
    const animation = parseFbxMotion(makeTestFbx())
    expect(animation.restHipsPosition.y).toBeCloseTo(0.9)
    const hips = animation.humanoidTracks.translation.get('hips')!
    expect(hips.values[1]).toBeCloseTo(0.9)
    expect(hips.values[hips.values.length - 2]).toBeCloseTo(0.9 + FIXTURE_MOTION.hipsLift)
  })

  it('「mixamorig1:」のような番号付きや、頭の文字が無いボーン名も受け付ける', () => {
    for (const prefix of ['mixamorig1:', '']) {
      const animation = parseFbxMotion(makeTestFbx(prefix))
      expect(angleBetween(lastQuat(animation.humanoidTracks.rotation.get('leftUpperArm')), FIXTURE_MOTION.leftUpperArm)).toBeLessThan(1e-3)
    }
  })

  it('Mixamo の骨格のボーンが無ければ読み込まない', () => {
    expect(() => parseFbxMotion(makeTestFbx('other_'))).toThrow()
  })
})

describe('parseMotion（.vrma と .fbx の振り分け）', () => {
  it('FBX と .vrma を中身で見分ける', () => {
    expect(isFbx(makeTestFbx())).toBe(true)
    expect(isFbx(makeTestVrma('idle'))).toBe(false)
  })

  it('どちらも VRM アニメーションとして読む', async () => {
    expect((await parseMotion(makeTestFbx())).humanoidTracks.rotation.has('leftUpperArm')).toBe(true)
    expect((await parseMotion(makeTestVrma('wave'))).humanoidTracks.rotation.has('rightUpperArm')).toBe(true)
  })

  it('どちらでもないデータは読み込まない', async () => {
    await expect(parseMotion(new TextEncoder().encode('not a motion').buffer as ArrayBuffer)).rejects.toThrow()
  })
})

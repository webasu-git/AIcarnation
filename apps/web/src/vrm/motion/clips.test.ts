import { describe, expect, it } from 'vitest'
import { parseVrma } from './clips'
import { makeTestVrma } from './vrmaFixture'

describe('parseVrma（VRM アニメーションの読み込み）', () => {
  it('.vrma から体のボーンの動きを読み取る', async () => {
    const animation = await parseVrma(makeTestVrma('wave'))
    expect(animation.duration).toBeCloseTo(2)
    expect([...animation.humanoidTracks.rotation.keys()].sort()).toEqual(['leftUpperArm', 'rightLowerArm', 'rightUpperArm'])
  })

  it('VRM アニメーションでないデータは読み込まない', async () => {
    await expect(parseVrma(new TextEncoder().encode('not a vrma').buffer as ArrayBuffer)).rejects.toThrow()
  })
})

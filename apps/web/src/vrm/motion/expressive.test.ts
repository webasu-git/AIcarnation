import { describe, expect, it } from 'vitest'
import { ExpressiveMotion } from './expressive'
import type { Pose } from './pose'

function step(m: ExpressiveMotion, seconds: number): Pose {
  let pose: Pose = {}
  for (let t = 0; t < seconds; t += 1 / 30) {
    pose = {}
    m.update(1 / 30, pose)
  }
  return pose
}

const ARM_BONE = /(Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)/

describe('ExpressiveMotion（感情の姿勢・文の終わりのうなずき）', () => {
  it('悲しみではうつむき、普段の顔に戻ると姿勢も戻る', () => {
    const m = new ExpressiveMotion()
    m.setEmotion('sad')
    expect(step(m, 2).head?.[0]).toBeGreaterThan(0.06)
    m.setEmotion('neutral')
    expect(step(m, 3).head?.[0] ?? 0).toBeLessThan(0.01)
  })

  it('感情や話す合図では、腕・肩・指は動かさない（モデルが崩れないよう、体の軸と頭だけ）', () => {
    for (const emotion of ['happy', 'sad', 'surprised', 'angry', 'relaxed'] as const) {
      const m = new ExpressiveMotion()
      m.setEmotion(emotion)
      m.cue({ type: 'sentenceStart' })
      m.cue({ type: 'beat' })
      const bones = Object.keys(step(m, 1))
      expect(bones.filter((b) => ARM_BONE.test(b))).toEqual([])
    }
  })

  it('話している間だけ手を前に上げ、話し終えると下ろす。腕を動かす動きのファイルがあれば出さない', () => {
    const m = new ExpressiveMotion()
    m.setSpeaking(true)
    const during = step(m, 1.5)
    expect(Math.abs(during.leftLowerArm?.[1] ?? 0)).toBeGreaterThan(1)
    expect(Math.abs(during.rightLowerArm?.[1] ?? 0)).toBeGreaterThan(1)
    m.setSpeaking(false)
    expect(step(m, 3).leftLowerArm).toBeUndefined()
    const byFile = new ExpressiveMotion()
    byFile.setSpeaking(true)
    let pose: Pose = {}
    for (let t = 0; t < 1.5; t += 1 / 30) {
      pose = {}
      byFile.update(1 / 30, pose, 0)
    }
    expect(pose.leftLowerArm).toBeUndefined()
  })

  it('問いかけで終わる文では首をかしげ、ふつうの文ではうなずく', () => {
    const q = new ExpressiveMotion()
    q.cue({ type: 'sentenceEnd', question: true })
    expect(step(q, 0.5).head?.[2]).toBeGreaterThan(0.05)
    const n = new ExpressiveMotion()
    n.cue({ type: 'sentenceEnd', question: false })
    expect(step(n, 0.3).head?.[0]).toBeGreaterThan(0.03)
  })
})

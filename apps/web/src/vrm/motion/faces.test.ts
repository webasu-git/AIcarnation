import { describe, expect, it } from 'vitest'
import { evaluateFace, faceForMotion } from './faces'

describe('faceForMotion（動きのファイル名から顔を決める）', () => {
  it('役の識別子や記号が付いた名前でも見分ける', () => {
    expect(faceForMotion('(気まぐれ)Yawn.fbx')?.cues?.[0]?.mouthOpen).toBeGreaterThan(0.5)
    expect(faceForMotion('Clapping(喜ぶ).fbx')?.emotion).toBe('happy')
    expect(faceForMotion('Thoughtful Head Shake.fbx')?.emotion).toBe('sad')
    expect(faceForMotion('Thoughtful Head Nod.fbx')?.emotion).toBe('happy')
    expect(faceForMotion('VRMA_03_ピース.vrma')?.emotion).toBe('happy')
    expect(faceForMotion('Standing Greeting.fbx')?.emotion).toBe('happy')
    expect(faceForMotion('Bored.fbx')?.emotion).toBe('relaxed')
    expect(faceForMotion('Look Around.fbx')?.emotion).toBe('surprised')
  })

  it('話す動きや見分けられない名前では、顔を変えない', () => {
    expect(faceForMotion('Talking1.fbx')).toBeNull()
    expect(faceForMotion('Neutral Idle.fbx')).toBeNull()
  })
})

describe('evaluateFace（動きの途中の顔）', () => {
  it('あくびは途中で目を閉じて口を開け、始めと終わりは閉じない', () => {
    const yawn = faceForMotion('Yawn.fbx')!
    expect(evaluateFace(yawn, 0.05).mouthOpen).toBe(0)
    expect(evaluateFace(yawn, 0.4).mouthOpen).toBeGreaterThan(0.8)
    expect(evaluateFace(yawn, 0.4).eyeClose).toBeGreaterThan(0.8)
    expect(evaluateFace(yawn, 0.95).eyeClose).toBe(0)
  })

  it('ずっと目を細める動きは、どの位置でも同じだけ細める', () => {
    const counting = faceForMotion('Counting.fbx')!
    expect(evaluateFace(counting, 0.1).eyeClose).toBeCloseTo(evaluateFace(counting, 0.8).eyeClose)
    expect(evaluateFace(counting, 0.5).emotion).toBeUndefined()
  })
})

describe('口の形', () => {
  it('動きごとに口の形が決まる', () => {
    expect(evaluateFace(faceForMotion('Clapping.fbx')!, 0.5).mouths.grin).toBeGreaterThan(0.5)
    expect(evaluateFace(faceForMotion('Thoughtful Head Shake.fbx')!, 0.5).mouths.frown).toBeGreaterThan(0.5)
    expect(evaluateFace(faceForMotion('Thinking.fbx')!, 0.5).mouths.pout).toBeGreaterThan(0.3)
    expect(evaluateFace(faceForMotion('Telling A Secret.fbx')!, 0.5).mouths.cat).toBeGreaterThan(0.5)
  })

  it('途中で別の形にする動きは、その間だけ移り変わる（投げキッスで口をとがらせる）', () => {
    const kiss = faceForMotion('Blow A Kiss.fbx')!
    expect(evaluateFace(kiss, 0.1).mouths.pucker ?? 0).toBe(0)
    expect(evaluateFace(kiss, 0.1).mouths.smile).toBeGreaterThan(0.5)
    expect(evaluateFace(kiss, 0.47).mouths.pucker).toBeGreaterThan(0.8)
    expect(evaluateFace(kiss, 0.47).mouths.smile ?? 0).toBeLessThan(0.2)
  })

  it('あくびで口を大きく開けている間は、閉じた口の形を弱める', () => {
    const yawn = faceForMotion('Yawn.fbx')!
    expect(evaluateFace(yawn, 0.05).mouths.flat).toBeGreaterThan(0.3)
    expect(evaluateFace(yawn, 0.4).mouths.flat ?? 0).toBeLessThan(0.05)
  })
})

describe('目を閉じて笑う形', () => {
  it('笑う動きの盛り上がるところだけで、始めと終わりは目を開けている', () => {
    const clap = faceForMotion('Clapping.fbx')!
    expect(evaluateFace(clap, 0.05).eyeSmile).toBe(0)
    expect(evaluateFace(clap, 0.5).eyeSmile).toBeGreaterThan(0.7)
    expect(evaluateFace(clap, 0.95).eyeSmile).toBe(0)
  })

  it('ずっと流れる待機・考え中の動きでは、目を閉じて笑わない', () => {
    for (const name of ['Happy Idle.fbx', 'Bored.fbx', 'Thinking.fbx', 'Idle.fbx']) {
      const face = faceForMotion(name)
      for (const t of [0.1, 0.5, 0.9]) expect(face ? evaluateFace(face, t).eyeSmile : 0).toBe(0)
    }
  })
})

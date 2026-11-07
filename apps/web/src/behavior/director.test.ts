import { describe, expect, it } from 'vitest'
import type { Gesture, IdleMood } from '../vrm/idle'
import { BehaviorDirector, timingForSettings, type DirectorTiming } from './director'

const TIMING: DirectorTiming = {
  afterglow: 1000,
  boredAfter: 10_000,
  dozeAfter: 20_000,
  awakeGesture: [3000, 3000],
  boredGesture: [2000, 2000],
}

function setup(busy = false) {
  let now = 0
  const moods: IdleMood[] = []
  const gestures: Gesture[] = []
  const woke: string[] = []
  let isBusy = busy
  const director = new BehaviorDirector(
    { setMood: (m) => moods.push(m), gesture: (g) => gestures.push(g), isGesturing: false },
    () => isBusy,
    TIMING,
    { onWake: (k) => woke.push(k) },
    () => now,
    () => 0,
  )
  return {
    director,
    moods,
    gestures,
    woke,
    advance(ms: number) {
      for (let i = 0; i < ms; i += 500) {
        now += 500
        director.tick()
      }
    },
    setBusy(v: boolean) {
      isBusy = v
    },
  }
}

describe('BehaviorDirector（ひとりで過ごす）', () => {
  it('余韻のあと身ぶりを始め、退屈 → 居眠りと移る', () => {
    const t = setup()
    t.advance(1000)
    expect(t.gestures).toEqual(['lookAround'])
    t.advance(9000)
    expect(t.moods).toEqual(['bored'])
    t.advance(10_000)
    expect(t.moods).toEqual(['bored', 'dozing'])
    const count = t.gestures.length
    t.advance(10_000)
    // 居眠り中は身ぶりをしない
    expect(t.gestures.length).toBe(count)
  })

  it('居眠り中に出来事が起きたら、目を覚まして知らせる', () => {
    const t = setup()
    t.advance(20_000)
    expect(t.director.currentMood).toBe('dozing')
    t.director.activity('conversation')
    expect(t.director.currentMood).toBe('awake')
    expect(t.gestures.at(-1)).toBe('wake')
    expect(t.woke).toEqual(['conversation'])
  })

  it('会話中は待機の時間を数えず、身ぶりもしない', () => {
    const t = setup(true)
    t.advance(30_000)
    expect(t.moods).toEqual([])
    expect(t.gestures).toEqual([])
    t.setBusy(false)
    t.advance(500)
    expect(t.gestures).toEqual([])
    t.advance(1000)
    expect(t.gestures).toEqual(['lookAround'])
  })

  it('設定に合わせて身ぶりの間隔を伸び縮みさせ、居眠りしない・身ぶりしないも選べる', () => {
    const base: DirectorTiming = { afterglow: 1000, boredAfter: 10_000, dozeAfter: 20_000, awakeGesture: [2000, 4000], boredGesture: [1000, 2000] }
    expect(timingForSettings(base, 'less', true).awakeGesture).toEqual([4000, 8000])
    expect(timingForSettings(base, 'normal', false).dozeAfter).toBe(Infinity)
    let now = 0
    const gestures: Gesture[] = []
    const d = new BehaviorDirector(
      { setMood: () => {}, gesture: (g) => gestures.push(g), isGesturing: false },
      () => false,
      timingForSettings(base, 'off', true),
      {},
      () => now,
      () => 0,
    )
    for (now = 0; now <= 15_000; now += 500) d.tick()
    expect(gestures).toEqual([])
  })
})

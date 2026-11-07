import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE } from '@aicarnation/shared'
import { emotionStyleFor, engineTone } from './tone'

describe('engineTone（感情に合わせた声の調子）', () => {
  it('感情が無い・ふつうのときは、声の設定のまま', () => {
    const voice = { ...DEFAULT_VOICE, rate: 1.2, intonation: 0.8, tempo: 1.1 }
    expect(engineTone(voice, null)).toEqual({ speed: 1.2, intonation: 0.8, tempo: 1.1 })
    expect(engineTone(voice, 'neutral')).toEqual({ speed: 1.2, intonation: 0.8, tempo: 1.1 })
  })

  it('喜びは抑揚を強く、悲しみは控えめでゆっくりにする', () => {
    const happy = engineTone(DEFAULT_VOICE, 'happy')
    const sad = engineTone(DEFAULT_VOICE, 'sad')
    expect(happy.intonation).toBeGreaterThan(1)
    expect(happy.tempo).toBeGreaterThan(1)
    expect(sad.intonation).toBeLessThan(1)
    expect(sad.speed).toBeLessThan(1)
  })

  it('感情に合わせない設定なら変えない。範囲（抑揚・緩急 0〜2、速さ 0.5〜2）からははみ出さない', () => {
    expect(engineTone({ ...DEFAULT_VOICE, emotional: false }, 'happy')).toEqual({ speed: 1, intonation: 1, tempo: 1 })
    const loud = engineTone({ ...DEFAULT_VOICE, rate: 2, intonation: 2, tempo: 2 }, 'surprised')
    expect(loud).toEqual({ speed: 2, intonation: 2, tempo: 2 })
  })
})

describe('emotionStyleFor（感情に合うスタイル）', () => {
  const styles = [
    { styleId: 1, speaker: 'まお', style: 'ノーマル' },
    { styleId: 2, speaker: 'まお', style: 'あまあま' },
    { styleId: 3, speaker: 'まお', style: 'せつなめ' },
    { styleId: 4, speaker: 'まお', style: 'おちつき' },
    { styleId: 10, speaker: 'ほか', style: '喜び' },
    { styleId: 20, speaker: 'テスト役', style: 'ノーマル' },
  ]

  it('同じ話者に合うスタイルがあれば、それにする', () => {
    expect(emotionStyleFor(1, 'happy', styles)).toBe(2)
    expect(emotionStyleFor(1, 'sad', styles)).toBe(3)
    expect(emotionStyleFor(1, 'relaxed', styles)).toBe(4)
  })

  it('合うものが無い・ほかの話者にしか無い・ふつうのときは、選んだスタイルのまま', () => {
    expect(emotionStyleFor(1, 'angry', styles)).toBe(1)
    expect(emotionStyleFor(20, 'happy', styles)).toBe(20)
    expect(emotionStyleFor(1, 'neutral', styles)).toBe(1)
    expect(emotionStyleFor(1, null, styles)).toBe(1)
    expect(emotionStyleFor(99, 'happy', styles)).toBe(99)
  })
})

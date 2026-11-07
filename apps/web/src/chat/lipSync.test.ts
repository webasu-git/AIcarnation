import { describe, expect, it } from 'vitest'
import { MORA_MS, planChar } from './lipSync'

const fixed = () => 0.5
const visemes = (ch: string, prev = null as Parameters<typeof planChar>[1]) =>
  planChar(ch, prev, fixed).map((s) => s.viseme)

describe('planChar', () => {
  it('かなを母音の口形にする（ひらがな・カタカナ・濁音）', () => {
    expect(['か', 'キ', 'す', 'テ', 'ご'].flatMap((c) => visemes(c))).toEqual(['aa', 'ih', 'ou', 'ee', 'oh'])
  })

  it('句読点では口を閉じて間を取る', () => {
    const [comma] = planChar('、', null, fixed)
    const [period] = planChar('。', null, fixed)
    expect(comma?.viseme).toBeNull()
    expect(period?.viseme).toBeNull()
    expect(period!.duration).toBeGreaterThan(comma!.duration)
  })

  it('長音は直前の母音を伸ばし、促音は閉じ、撥音はほぼ閉じる', () => {
    expect(visemes('ー', 'oh')).toEqual(['oh'])
    expect(visemes('っ')).toEqual([null])
    const [n] = planChar('ん', null, fixed)
    expect(n?.weight).toBeLessThan(0.2)
  })

  it('小書きかなは短い拍で母音だけ切り替える', () => {
    const [ya] = planChar('ゃ', 'ih', fixed)
    expect(ya?.viseme).toBe('aa')
    expect(ya!.duration).toBeLessThan(MORA_MS)
  })

  it('漢字は2拍、括弧や空白は口を動かさない', () => {
    expect(planChar('話', null, fixed)).toHaveLength(2)
    expect(planChar('「', null, fixed)).toEqual([])
    expect(planChar(' ', null, fixed)).toEqual([])
  })

  it('開き具合は 0〜1 に収まり、「あ」より「い」「う」を控えめにする', () => {
    const a = planChar('あ', null, fixed)[0]!.weight
    const i = planChar('い', null, fixed)[0]!.weight
    expect(a).toBeLessThanOrEqual(1)
    expect(i).toBeLessThan(a)
  })
})

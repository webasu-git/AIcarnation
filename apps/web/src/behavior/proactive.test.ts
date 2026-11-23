import { describe, expect, it } from 'vitest'
import { ProactiveSuggester, proactiveTiming, type Suggestion } from './proactive'

function setup(answer: Suggestion | Error = { propose: true, emotion: 'relaxed', text: '続きをやらない？', id: 'a1' }) {
  let now = 0
  const state = { enabled: true, busy: false, requests: 0, said: [] as string[], spoken: [] as string[], sayOk: true }
  let settle: (() => void) | null = null
  const suggester = new ProactiveSuggester(
    {
      enabled: () => state.enabled,
      busy: () => state.busy,
      request: () => {
        state.requests++
        return new Promise<Suggestion>((resolve, reject) => {
          settle = () => (answer instanceof Error ? reject(answer) : resolve(answer))
        })
      },
      say: (raw) => {
        if (state.sayOk) state.said.push(raw)
        return state.sayOk
      },
      spoken: (id) => state.spoken.push(id),
      now: () => now,
    },
    { prepareAfter: 240, speakAfter: 300 },
  )
  /** 時刻を進めて tick する */
  const at = (t: number) => {
    now = t
    suggester.tick()
  }
  /** 依頼の答えを届ける */
  const answerNow = async () => {
    settle?.()
    await Promise.resolve()
    await Promise.resolve()
  }
  return { suggester, state, at, answerNow }
}

describe('ProactiveSuggester', () => {
  it('作り始めの時刻に依頼し、話す時刻に話して知らせる（1回だけ）', async () => {
    const { state, at, answerNow } = setup()
    at(239)
    expect(state.requests).toBe(0)
    at(240)
    expect(state.requests).toBe(1)
    await answerNow()
    at(299)
    expect(state.said).toEqual([])
    at(300)
    expect(state.said).toEqual(['[relaxed] 続きをやらない？'])
    expect(state.spoken).toEqual(['a1'])
    at(900)
    expect(state.requests).toBe(1)
    expect(state.said.length).toBe(1)
  })

  it('話す前に出来事があれば、提案を捨てて数え直す', async () => {
    const { suggester, state, at, answerNow } = setup()
    at(240)
    await answerNow()
    at(280)
    suggester.activity()
    at(300)
    expect(state.said).toEqual([])
    expect(state.spoken).toEqual([])
    // 出来事から数え直して、また依頼する
    at(280 + 240)
    expect(state.requests).toBe(2)
  })

  it('依頼中に出来事があれば、あとから届いた答えは捨てる', async () => {
    const { suggester, state, at, answerNow } = setup()
    at(240)
    suggester.activity()
    await answerNow()
    at(600)
    expect(state.said).toEqual([])
  })

  it('話す時刻に間に合わなければ、その回はあきらめる', async () => {
    const { state, at, answerNow } = setup()
    at(240)
    at(300)
    await answerNow()
    at(400)
    expect(state.said).toEqual([])
    expect(state.requests).toBe(1)
  })

  it('「提案なし」・失敗なら話さない', async () => {
    for (const answer of [{ propose: false, reason: 'なし' }, new Error('失敗')]) {
      const { state, at, answerNow } = setup(answer)
      at(240)
      await answerNow()
      at(300)
      expect(state.said).toEqual([])
      expect(state.spoken).toEqual([])
    }
  })

  it('話せなかったら知らせない', async () => {
    const { state, at, answerNow } = setup()
    state.sayOk = false
    at(240)
    await answerNow()
    at(300)
    expect(state.spoken).toEqual([])
  })

  it('オフ・取り込み中は放置に数えない', async () => {
    const { state, at } = setup()
    state.busy = true
    at(1000)
    expect(state.requests).toBe(0)
    state.busy = false
    at(1100)
    expect(state.requests).toBe(0)
    at(1000 + 240)
    expect(state.requests).toBe(1)

    const off = setup()
    off.state.enabled = false
    off.at(1000)
    expect(off.state.requests).toBe(0)
  })
})

describe('proactiveTiming', () => {
  it('話す 1 分前に作り始める。早送りにも合わせる', () => {
    expect(proactiveTiming(5)).toEqual({ prepareAfter: 240_000, speakAfter: 300_000 })
    expect(proactiveTiming(1)).toEqual({ prepareAfter: 48_000, speakAfter: 60_000 })
    expect(proactiveTiming(5, 60)).toEqual({ prepareAfter: 4_000, speakAfter: 5_000 })
  })
})

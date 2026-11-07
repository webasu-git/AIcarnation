import { describe, expect, it } from 'vitest'
import { DEFAULT_LINES } from './lines'
import { LineReactor, type ReactionTiming } from './reactions'

const TIMING: ReactionTiming = { cooldown: 10_000, touchCooldown: 5000, longTask: 60_000, absence: 600_000 }

function setup(canSpeak = true) {
  let now = 1_000_000
  const said: string[] = []
  const reactor = new LineReactor(
    {
      say: (raw) => {
        if (!canSpeak) return false
        said.push(raw)
        return true
      },
      book: () => DEFAULT_LINES,
      now: () => now,
      random: () => 0,
    },
    TIMING,
  )
  return {
    reactor,
    said,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('LineReactor（出来事への反応）', () => {
  it('テストの結果に反応する', () => {
    const t = setup()
    t.reactor.onEvent({ type: 'notice', kind: 'tests-passed' })
    expect(t.said).toEqual([DEFAULT_LINES.testsPassed[0]])
  })

  it('コマンドの失敗は、1回のやり取りにつき1度だけ反応する', () => {
    const t = setup()
    t.reactor.onEvent({ type: 'notice', kind: 'command-failed' })
    t.advance(20_000)
    t.reactor.onEvent({ type: 'notice', kind: 'command-failed' })
    expect(t.said).toHaveLength(1)
    t.reactor.onEvent({ type: 'listening', text: '次' })
    t.advance(20_000)
    t.reactor.onEvent({ type: 'notice', kind: 'command-failed' })
    expect(t.said).toHaveLength(2)
  })

  it('同じ台詞が続かないようにする', () => {
    const t = setup()
    t.reactor.onEvent({ type: 'notice', kind: 'tests-passed' })
    t.reactor.onEvent({ type: 'notice', kind: 'tests-passed' })
    expect(t.said[0]).not.toBe(t.said[1])
  })

  it('長く話しかけられなかったあとは「おかえり」と言う', () => {
    const t = setup()
    t.advance(600_000)
    t.reactor.onEvent({ type: 'listening', text: 'ただいま' })
    expect(t.said).toEqual([DEFAULT_LINES.welcomeBack[0]])
    t.advance(1000)
    t.reactor.onEvent({ type: 'listening', text: 'もう一つ' })
    expect(t.said).toHaveLength(1)
  })

  it('作業が長く続いたら一度だけ一言かける（要約中は数えない）', () => {
    const t = setup()
    t.reactor.onEvent({ type: 'working', label: 'ファイルを読んでいます' })
    t.advance(59_000)
    t.reactor.tick()
    expect(t.said).toHaveLength(0)
    t.advance(2000)
    t.reactor.tick()
    t.advance(60_000)
    t.reactor.tick()
    expect(t.said).toEqual([DEFAULT_LINES.longTask[0]])
  })

  it('頭をなでる・体をつつくで台詞を変え、続けて触られたら間隔をあける', () => {
    const t = setup()
    expect(t.reactor.onTouch('head')).toBe(true)
    expect(t.said).toEqual([DEFAULT_LINES.headPat[0]])
    t.advance(1000)
    expect(t.reactor.onTouch('body')).toBe(false)
    t.advance(5000)
    expect(t.reactor.onTouch('body')).toBe(true)
    expect(t.said.at(-1)).toBe(DEFAULT_LINES.touched[0])
  })

  it('返答を話している最中など、話せないときは間隔を消費しない', () => {
    const t = setup(false)
    t.reactor.onEvent({ type: 'notice', kind: 'command-failed' })
    expect(t.said).toHaveLength(0)
  })
})

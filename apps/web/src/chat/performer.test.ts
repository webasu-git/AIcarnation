import { describe, expect, it, vi } from 'vitest'
import type { SpeechHandle } from '../voice/speech'
import { ReplyPerformer, type AvatarControl } from './performer'

const avatar: AvatarControl = { setEmotion: () => {}, setMouth: () => {}, setMotion: () => {}, nod: () => {} }

/** 声が出始めてから boundary を後で送れる偽の読み上げ */
function fakeSpeech() {
  let started!: () => void
  let ended!: () => void
  const listeners: ((start: number, length: number) => void)[] = []
  const handle: SpeechHandle = {
    started: new Promise((r) => (started = r)),
    ended: new Promise((r) => (ended = r)),
    onWord: (l) => listeners.push(l),
    cancel: () => ended(),
  }
  return { handle, start: () => started(), end: () => ended(), word: (s: number, l: number) => listeners.forEach((f) => f(s, l)) }
}

function performerWith(speech: ReturnType<typeof fakeSpeech>) {
  let shown = ''
  // テストは Node で動くので、タイマーを持つ globalThis をウィンドウの代わりにする
  const performer = new ReplyPerformer(avatar, (t) => (shown += t), () => globalThis as unknown as Window, {
    rate: 1,
    speak: () => speech.handle,
  })
  return { performer, shown: () => shown }
}

describe('ReplyPerformer（声に合わせた文字送り）', () => {
  it('単語の知らせで、その単語の文字を出す', async () => {
    vi.useFakeTimers()
    const speech = fakeSpeech()
    const { performer, shown } = performerWith(speech)
    performer.enqueue([{ emotion: null, text: 'こんにちは。' }])
    speech.start()
    await vi.advanceTimersByTimeAsync(10)
    speech.word(0, 5)
    await vi.advanceTimersByTimeAsync(10)
    expect(shown()).toBe('こんにちは')
    speech.end()
    await vi.runAllTimersAsync()
    await performer.finish()
    expect(shown()).toBe('こんにちは。')
    vi.useRealTimers()
  })

  it('知らせが遅れて届いても、時間での文字送りに切り替えたあとは文字が二重にならない', async () => {
    vi.useFakeTimers()
    const speech = fakeSpeech()
    const { performer, shown } = performerWith(speech)
    performer.enqueue([{ emotion: null, text: '同梱版です。' }])
    speech.start()
    // 知らせが来ないまま見極めの時間が過ぎ、時間での文字送りが始まる
    await vi.advanceTimersByTimeAsync(800)
    speech.word(0, 3)
    speech.word(3, 2)
    await vi.runAllTimersAsync()
    speech.end()
    await vi.runAllTimersAsync()
    await performer.finish()
    expect(shown()).toBe('同梱版です。')
    vi.useRealTimers()
  })

  it('文の頭・読点・文の終わりで、手ぶりとうなずきの合図を出す', async () => {
    vi.useFakeTimers()
    const cues: string[] = []
    const performer = new ReplyPerformer(
      { ...avatar, speechCue: (c) => cues.push(c.type === 'sentenceEnd' ? `end:${c.question}` : c.type) },
      () => {},
      () => globalThis as unknown as Window,
    )
    performer.enqueue([
      { emotion: null, text: 'はい、そうです。' },
      { emotion: null, text: '本当ですか？' },
    ])
    await vi.runAllTimersAsync()
    await performer.finish()
    expect(cues).toEqual(['sentenceStart', 'beat', 'end:false', 'sentenceStart', 'end:true'])
    vi.useRealTimers()
  })

  it('今の文を読んでいる間に、次の文を先に用意させる（まとめて届いたとき・あとから届いたとき）', async () => {
    vi.useFakeTimers()
    const speeches = [fakeSpeech(), fakeSpeech(), fakeSpeech()]
    let n = 0
    const prefetched: string[] = []
    const performer = new ReplyPerformer(avatar, () => {}, () => globalThis as unknown as Window, {
      rate: 1,
      speak: () => speeches[n++]!.handle,
      prefetch: (text) => prefetched.push(text),
    })
    performer.enqueue([
      { emotion: null, text: '一つ目。' },
      { emotion: null, text: '二つ目。' },
    ])
    await vi.advanceTimersByTimeAsync(10)
    expect(prefetched).toEqual(['二つ目。'])
    // 一つ目を読んでいる最中に三つ目が届く（このときの次は二つ目なので、増えない）
    performer.enqueue([{ emotion: null, text: '三つ目。' }])
    expect(prefetched).toEqual(['二つ目。', '二つ目。'])
    for (const s of speeches) {
      s.start()
      s.end()
      await vi.runAllTimersAsync()
    }
    await performer.finish()
    // 二つ目を読み始めたときに、三つ目を先に用意させている
    expect(prefetched).toContain('三つ目。')
    vi.useRealTimers()
  })

  it('読み上げ中に次の文が届いたら、その場で先に用意させる', async () => {
    vi.useFakeTimers()
    const speeches = [fakeSpeech(), fakeSpeech()]
    let n = 0
    const prefetched: string[] = []
    const performer = new ReplyPerformer(avatar, () => {}, () => globalThis as unknown as Window, {
      rate: 1,
      speak: () => speeches[n++]!.handle,
      prefetch: (text) => prefetched.push(text),
    })
    performer.enqueue([{ emotion: null, text: '一つ目。' }])
    await vi.advanceTimersByTimeAsync(10)
    expect(prefetched).toEqual([])
    performer.enqueue([{ emotion: null, text: '二つ目。' }])
    expect(prefetched).toEqual(['二つ目。'])
    for (const s of speeches) {
      s.start()
      s.end()
      await vi.runAllTimersAsync()
    }
    await performer.finish()
    vi.useRealTimers()
  })

  it('文の感情を声にも渡す。タグの無い文は前の文の感情を引き継ぐ（先に用意する文も同じ）', async () => {
    vi.useFakeTimers()
    const speeches = [fakeSpeech(), fakeSpeech(), fakeSpeech()]
    let n = 0
    const spoken: [string, string | null][] = []
    const prefetched: [string, string | null][] = []
    const performer = new ReplyPerformer(avatar, () => {}, () => globalThis as unknown as Window, {
      rate: 1,
      speak: (text, emotion) => {
        spoken.push([text, emotion])
        return speeches[n++]!.handle
      },
      prefetch: (text, emotion) => prefetched.push([text, emotion]),
    })
    performer.enqueue([
      { emotion: 'happy', text: 'やった。' },
      { emotion: null, text: 'すごいね。' },
      { emotion: 'sad', text: 'でも少し寂しい。' },
    ])
    for (const s of speeches) {
      await vi.advanceTimersByTimeAsync(10)
      s.start()
      s.end()
      await vi.runAllTimersAsync()
    }
    await performer.finish()
    expect(spoken).toEqual([
      ['やった。', 'happy'],
      ['すごいね。', 'happy'],
      ['でも少し寂しい。', 'sad'],
    ])
    expect(prefetched).toEqual([
      ['すごいね。', 'happy'],
      ['でも少し寂しい。', 'sad'],
    ])
    vi.useRealTimers()
  })

  it('表情は声が出始めたときに変える（合成を待つ間に顔だけ先に変わらない）', async () => {
    vi.useFakeTimers()
    const speech = fakeSpeech()
    const emotions: string[] = []
    const performer = new ReplyPerformer(
      { ...avatar, setEmotion: (e) => emotions.push(e) },
      () => {},
      () => globalThis as unknown as Window,
      { rate: 1, speak: () => speech.handle },
    )
    performer.enqueue([{ emotion: 'happy', text: 'やった。' }])
    await vi.advanceTimersByTimeAsync(10)
    expect(emotions).toEqual([])
    speech.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(emotions).toEqual(['happy'])
    speech.end()
    await vi.runAllTimersAsync()
    await performer.finish()
    vi.useRealTimers()
  })
})

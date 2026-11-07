import { ref } from 'vue'
import type { AgentVoice, Emotion, VoiceOption } from '@aicarnation/shared'
import { getAudioVolume, playAudio, type Playback } from './audio'
import {
  cachedEngineStyles,
  ENGINES,
  engineWarmup,
  parseEngineVoiceURI,
  synthesize,
  timeMoras,
  type EngineId,
  type Synthesized,
  type TimedMora,
} from './engines'
import { emotionStyleFor, engineTone } from './tone'

export function isSpeechSupported(): boolean {
  return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
}

/**
 * 使える声の一覧。Chrome は最初は空で、voiceschanged の後に揃うので少し待つ
 */
export async function listVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!isSpeechSupported()) return []
  const now = speechSynthesis.getVoices()
  if (now.length > 0) return now
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices())
    speechSynthesis.addEventListener('voiceschanged', done, { once: true })
    setTimeout(done, 1500)
  })
}

/** 推薦用に、日本語の声を先頭にして件数を絞る */
export function toVoiceOptions(voices: SpeechSynthesisVoice[], limit: number): VoiceOption[] {
  const isJa = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().startsWith('ja')
  return [...voices.filter(isJa), ...voices.filter((v) => !isJa(v))]
    .slice(0, limit)
    .map((v) => ({ voiceURI: v.voiceURI, name: v.name, lang: v.lang }))
}

/** voiceURI の声。この端末に無ければ日本語の声、それも無ければ既定の声（null） */
function resolveVoice(voiceURI: string): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices()
  return (
    voices.find((v) => v.voiceURI === voiceURI) ?? voices.find((v) => v.lang.toLowerCase().startsWith('ja')) ?? null
  )
}

/** 音声エンジンで再生しているときの、口の動きに使う情報 */
export interface AudioTrack {
  /** 拍（母音）ごとの時刻 */
  moras: TimedMora[]
  /** 再生を始めた時刻（performance.now() の値） */
  startedAt: number
  /** いま鳴っている音の大きさ */
  level(): number
}

export interface SpeechHandle {
  /** 声が出始めたら resolve する */
  started: Promise<void>
  /** 読み終わる・止められる・失敗するのいずれかで resolve する */
  ended: Promise<void>
  /**
   * 単語を話し始めるたびに呼ばれる（文中の位置と長さ）。口の動きと文字送りを声に合わせるのに使う。
   * この知らせを出さない声もある
   */
  onWord(listener: (start: number, length: number) => void): void
  /**
   * 音声エンジンで話すときだけある。再生が始まると拍の時刻と音の大きさを返す。
   * エンジンが使えずブラウザの声に切り替えたときは null
   */
  audio?: Promise<AudioTrack | null>
  cancel(): void
}

/**
 * 音声エンジンが使えずブラウザの声に切り替えたときの知らせ。画面に出す。
 * 次にエンジンで話せたら消す
 */
export const voiceNotice = ref('')

/**
 * Chrome は SpeechSynthesisUtterance がガベージコレクトされると onend が来なくなることがあるため、
 * 読み上げ中は参照を持っておく
 */
const speaking = new Set<SpeechSynthesisUtterance>()
/** 音声エンジンで再生中のもの（stopSpeech で止める） */
const playing = new Set<Playback>()

/**
 * 先に合成しておいた音声（声の設定・感情・文ごと）。
 * 音声エンジンは1文の合成に数秒かかるので、今の文を読んでいる間に次の文を合成しておき、文と文のあいだの沈黙をなくす
 */
const prefetched = new Map<string, Promise<Synthesized>>()
/** 先に合成しておく数の上限（使われずに残ったものを溜めこまない） */
const MAX_PREFETCHED = 6

function prefetchKey(voice: AgentVoice, emotion: Emotion | null, text: string): string {
  return JSON.stringify([voice.voiceURI, voice.rate, voice.intonation, voice.tempo, voice.emotional, emotion, text])
}

/**
 * 感情に合わせたスタイルと調子で1文を合成する。
 * 声のモデルに感情ごとのスタイルがあればそれで、無ければ選んだスタイルの抑揚とテンポを変える
 */
async function synthesizeWithTone(
  engine: EngineId,
  styleId: number,
  text: string,
  voice: AgentVoice,
  emotion: Emotion | null,
): Promise<Synthesized> {
  const style = voice.emotional === false ? styleId : emotionStyleFor(styleId, emotion, await cachedEngineStyles(engine))
  return synthesize(engine, style, text, engineTone(voice, emotion))
}

/**
 * 次に読む文を、先に合成しておく。声の設定がエンジンのときだけ（ブラウザの声は先に作れない）。
 * エンジンの起動を待っている間は、起動を待つほうに任せて何もしない
 */
export function prefetchSpeech(text: string, voice: AgentVoice, emotion: Emotion | null = null): void {
  const engine = parseEngineVoiceURI(voice.voiceURI)
  if (!engine || !engineWarmup.isReady(engine.engine)) return
  const key = prefetchKey(voice, emotion, text)
  if (prefetched.has(key)) return
  const task = synthesizeWithTone(engine.engine, engine.styleId, text, voice, emotion)
  // 失敗は、読み上げるときに改めて扱う（ここでは握りつぶして、未処理の失敗にしない）
  task.catch(() => undefined)
  prefetched.set(key, task)
  while (prefetched.size > MAX_PREFETCHED) {
    const oldest = prefetched.keys().next().value
    if (oldest === undefined) break
    prefetched.delete(oldest)
  }
}

/** 先に合成してあればそれを取り出す（1回使ったら消す） */
function takePrefetched(key: string): Promise<Synthesized> | undefined {
  const task = prefetched.get(key)
  prefetched.delete(key)
  return task
}

/**
 * 1文を読み上げる。声の設定がエンジン（engine:…）ならエンジンで、それ以外はブラウザの声で。
 * emotion はその文の感情（エンジンの声だけ、感情に合わせて調子を変える）
 */
export function speak(text: string, voice: AgentVoice, emotion: Emotion | null = null): SpeechHandle {
  const engine = parseEngineVoiceURI(voice.voiceURI)
  return engine ? speakWithEngine(text, voice, emotion, engine.engine, engine.styleId) : speakWithBrowser(text, voice)
}

/** ブラウザの声で読み上げる。onend が来ない環境に備え、長さから見積もった時間で打ち切る */
function speakWithBrowser(text: string, voice: AgentVoice): SpeechHandle {
  const utterance = new SpeechSynthesisUtterance(text)
  const resolved = resolveVoice(voice.voiceURI)
  if (resolved) utterance.voice = resolved
  utterance.lang = resolved?.lang ?? 'ja-JP'
  utterance.rate = voice.rate
  utterance.pitch = voice.pitch
  // 音量は読み上げを始めるときに決まる（話している途中の変更は次の文から効く）
  utterance.volume = getAudioVolume()

  let start!: () => void
  const started = new Promise<void>((resolve) => {
    start = resolve
  })
  let finish!: () => void
  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })
  const timeout = window.setTimeout(() => finish(), (text.length * 300) / voice.rate + 3000)
  const cleanup = () => {
    window.clearTimeout(timeout)
    speaking.delete(utterance)
    start()
    finish()
  }
  const wordListeners: ((start: number, length: number) => void)[] = []
  utterance.onstart = () => start()
  utterance.onboundary = (e) => {
    if (e.name !== 'word') return
    for (const listener of wordListeners) listener(e.charIndex, Math.max(1, e.charLength ?? 1))
  }
  utterance.onend = cleanup
  utterance.onerror = cleanup
  speaking.add(utterance)
  speechSynthesis.speak(utterance)

  return {
    started,
    ended,
    onWord: (listener) => {
      wordListeners.push(listener)
    },
    cancel() {
      speechSynthesis.cancel()
      cleanup()
    },
  }
}

/**
 * 音声エンジンで読み上げる。合成・再生できなければ、その文はブラウザの声で読み上げて知らせる
 */
function speakWithEngine(
  text: string,
  voice: AgentVoice,
  emotion: Emotion | null,
  engine: EngineId,
  styleId: number,
): SpeechHandle {
  let start!: () => void
  const started = new Promise<void>((resolve) => {
    start = resolve
  })
  let finish!: () => void
  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })
  const wordListeners: ((start: number, length: number) => void)[] = []
  let cancelled = false
  let playback: Playback | null = null
  let fallback: SpeechHandle | null = null

  const label = ENGINES.find((e) => e.id === engine)?.label ?? engine
  const audio = (async (): Promise<AudioTrack | null> => {
    try {
      // エンジンが起動中なら、起動を待ってから話す（待たずにブラウザの声にしない）。使えないと分かったら下でブラウザの声にする
      if (!engineWarmup.isReady(engine)) {
        voiceNotice.value = `${label}を起動しています…`
        await engineWarmup.warmUp(engine)
        if (cancelled) throw new Error('取り消しました')
      }
      const synthesized = await (takePrefetched(prefetchKey(voice, emotion, text)) ??
        synthesizeWithTone(engine, styleId, text, voice, emotion))
      if (cancelled) return null
      const current = await playAudio(synthesized.audio)
      playback = current
      if (cancelled) {
        current.stop()
        return null
      }
      playing.add(current)
      voiceNotice.value = ''
      start()
      void current.ended.then(() => {
        playing.delete(current)
        finish()
      })
      return { moras: timeMoras(synthesized, current.duration), startedAt: current.startedAt, level: () => current.level() }
    } catch (err) {
      if (cancelled) {
        start()
        finish()
        return null
      }
      engineWarmup.markDown(engine)
      const reason = err instanceof Error ? err.message : String(err)
      voiceNotice.value = `${label}を利用できないため、ブラウザの声で話しています（${reason}）`
      const browser = speakWithBrowser(text, { ...voice, voiceURI: '' })
      fallback = browser
      for (const listener of wordListeners) browser.onWord(listener)
      void browser.started.then(start)
      void browser.ended.then(finish)
      return null
    }
  })()

  return {
    started,
    ended,
    audio,
    onWord: (listener) => {
      wordListeners.push(listener)
      fallback?.onWord(listener)
    },
    cancel() {
      cancelled = true
      playback?.stop()
      fallback?.cancel()
      start()
      finish()
    },
  }
}

/** 読み上げ中のものをすべて止める */
export function stopSpeech(): void {
  prefetched.clear()
  if (isSpeechSupported()) speechSynthesis.cancel()
  for (const p of playing) p.stop()
  playing.clear()
}

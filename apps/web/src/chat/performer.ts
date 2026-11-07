import type { Emotion } from '@aicarnation/shared'
import type { Viseme } from '../vrm/expression'
import type { MotionState } from '../vrm/idle'
import type { SpeechCue } from '../vrm/motion/expressive'
import type { AudioTrack, SpeechHandle } from '../voice/speech'
import type { Sentence } from './emotionParser'
import { planChar, visemeForVowel, type MouthStep } from './lipSync'

/** 表情・口・姿勢を動かす相手。VrmViewer が満たす */
export interface AvatarControl {
  setEmotion(emotion: Emotion): void
  setMouth(viseme: Viseme | null, weight: number): void
  /** 会話の様子に合わせた姿勢（聞いている・考えている・作業中・話している） */
  setMotion(state: MotionState): void
  nod(): void
  /** 話すときの合図（手ぶり・うなずき）。体を動かせない相手では省ける */
  speechCue?(cue: SpeechCue): void
}

/** 1文を読み上げる。音声オフのときは null を返す */
export interface Speaker {
  /** emotion はその文の感情（タグの無い文は、前の文の感情を引き継ぐ）。声の調子を合わせるのに使う */
  speak(text: string, emotion: Emotion | null): SpeechHandle | null
  /** 次に読む文を先に用意しておく（音声エンジンで合成に時間がかかるとき、文と文のあいだの待ちをなくす） */
  prefetch?(text: string, emotion: Emotion | null): void
  /** 読み上げの速さ（口の動きもこれに合わせる） */
  rate: number
}

const SENTENCE_PAUSE_MS = 160
/** 区切りの手ぶりを出す文字（読点など） */
const BEAT_MARKS = /[、，,]/
/** 問いかけで終わる文（首をかしげる） */
const QUESTION_END = /[？?][」』）)]*\s*$/
/** 拍の後半は口を少しすぼめ、拍ごとの区切りを出す（完全には閉じない） */
const MORA_HOLD_RATIO = 0.6
const MORA_RELAX = 0.35
/** 声が出始めるのを待つ上限 */
const START_TIMEOUT_MS = 1500
/** 単語の知らせ（boundary）が来るかを見極める時間。来ない声は時間で文字送りする */
const BOUNDARY_GRACE_MS = 700
/** 音声エンジンの合成・再生が始まるのを待つ上限 */
const AUDIO_START_TIMEOUT_MS = 20_000
/** 音声エンジンの口パクを更新する間隔 */
const AUDIO_FRAME_MS = 33
/** 音の大きさ（RMS）から口の開き具合への換算。これより小さい音は無音とみなす */
const AUDIO_LEVEL_FLOOR = 0.015
const AUDIO_LEVEL_GAIN = 6
/** 口の開き具合の上限（「あ」のとき）。大げさにならないよう控えめにする */
const AUDIO_MAX_OPEN = 0.6

/**
 * 届いた文を順に演じる：文頭の感情で表情を変え、口を動かしながら文字を出す（擬似口パク）。
 * 口の形は、かなを母音（あいうえお）に変換して拍ごとに切り替える。
 *
 * 音声オンのときは声に合わせる：声が単語を話し始めた知らせ（boundary）でその単語の文字を出し、
 * その単語の分だけ口を動かす。息継ぎなど声が止まっている間は口を閉じる。
 * 知らせを出さない声では、話速から見積もった時間で文字を送る。
 *
 * タイマーは getWindow() のウィンドウで回す。小窓表示中に本体タブが裏に回ると
 * 本体のタイマーは間引かれるため、表示中のウィンドウ（小窓）のタイマーを使う。
 */
export class ReplyPerformer {
  private queue: Sentence[] = []
  private running: Promise<void> | null = null
  private cancelled = false
  private speech: SpeechHandle | null = null
  /** 声の調子に使う感情（タグの無い文は前の文の感情を引き継ぐ） */
  private voiceEmotion: Emotion | null = null

  constructor(
    private readonly avatar: AvatarControl,
    private readonly onText: (text: string) => void,
    private readonly getWindow: () => Window,
    private readonly speaker: Speaker | null = null,
  ) {}

  enqueue(sentences: Sentence[]): void {
    if (this.cancelled || sentences.length === 0) return
    this.queue.push(...sentences)
    // 返事は少しずつ届くので、読み上げ中に次の文が届いたら、その場で先に用意しておく
    const next = this.queue[0]
    if (this.speech && next) this.speaker?.prefetch?.(next.text, next.emotion ?? this.voiceEmotion)
    this.running ??= this.run().finally(() => {
      this.running = null
    })
  }

  /** キューが空になるまで待つ */
  async finish(): Promise<void> {
    while (this.running) await this.running
  }

  /** 演技と読み上げを止める（次の入力が来たときなど） */
  cancel(): void {
    this.cancelled = true
    this.queue = []
    this.speech?.cancel()
    this.avatar.setMouth(null, 0)
  }

  /** 文字を出す。読点（区切り）を出したら小さな手ぶりの合図も出す */
  private emit(text: string): void {
    if (BEAT_MARKS.test(text)) this.cue({ type: 'beat' })
    this.onText(text)
  }

  private cue(cue: SpeechCue): void {
    this.avatar.speechCue?.(cue)
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.getWindow().setTimeout(resolve, ms))
  }

  private async run(): Promise<void> {
    for (let s = this.queue.shift(); s && !this.cancelled; s = this.queue.shift()) {
      this.voiceEmotion = s.emotion ?? this.voiceEmotion
      const speech = this.speaker?.speak(s.text, this.voiceEmotion) ?? null
      // 今の文を読んでいる間に、次の文を先に用意しておく
      const next = this.queue[0]
      if (speech && next) this.speaker?.prefetch?.(next.text, next.emotion ?? this.voiceEmotion)
      if (speech) {
        // 音声エンジンは合成に時間がかかるので、表情と手ぶりは声が出始めたときに出す（先に体だけ動かないように）
        const emotion = s.emotion
        void speech.started.then(() => {
          if (this.cancelled) return
          if (emotion) this.avatar.setEmotion(emotion)
          this.cue({ type: 'sentenceStart' })
        })
        await this.performWithSpeech(s.text, speech, this.speaker?.rate ?? 1)
      } else {
        if (s.emotion) this.avatar.setEmotion(s.emotion)
        this.cue({ type: 'sentenceStart' })
        await this.type(s.text, 1)
      }
      this.avatar.setMouth(null, 0)
      // 文の終わりにうなずく（問いかけなら首をかしげる）
      if (!this.cancelled) this.cue({ type: 'sentenceEnd', question: QUESTION_END.test(s.text) })
      await this.wait(SENTENCE_PAUSE_MS)
    }
    this.avatar.setMouth(null, 0)
  }

  /** 声に合わせて1文を演じる */
  private async performWithSpeech(text: string, speech: SpeechHandle, rate: number): Promise<void> {
    this.speech = speech
    // 音声エンジンなら、拍の時刻と音の大きさで口を動かす（合成に時間がかかるので、始まるまで待つ）
    if (speech.audio) {
      const track = await Promise.race([speech.audio, this.wait(AUDIO_START_TIMEOUT_MS).then(() => null)])
      if (track) return this.performWithAudio(text, speech, track)
      if (this.cancelled) return
      // エンジンが使えずブラウザの声に切り替わった：以下の単語の知らせに合わせる
    }
    let revealed = 0
    const reveal = (upTo: number) => {
      const end = Math.min(upTo, text.length)
      if (end > revealed) {
        this.emit(text.slice(revealed, end))
        revealed = end
      }
    }

    let ended = false
    void speech.ended.then(() => {
      ended = true
    })
    // 新しい単語が来たら、前の単語の口の動きはやめて次へ移る
    let word = 0
    let gotBoundary = false
    /** 時間での文字送りに切り替えたら、あとから届いた知らせは使わない（文字が二重に出ないように） */
    let byTime = false
    speech.onWord((start, length) => {
      if (this.cancelled || byTime) return
      gotBoundary = true
      reveal(start + length)
      const mine = ++word
      void this.mouthWord(text.slice(start, start + length), rate, () => mine === word && !ended)
    })

    await Promise.race([speech.started, this.wait(START_TIMEOUT_MS)])
    await Promise.race([speech.ended, this.wait(BOUNDARY_GRACE_MS)])
    if (!gotBoundary && !ended && !this.cancelled) {
      // 単語の知らせを出さない声：話速から見積もって文字を送り、残りは口を閉じて待つ
      byTime = true
      const from = revealed
      await this.type(text.slice(from), rate, (n) => reveal(from + n))
      this.avatar.setMouth(null, 0)
    }
    await speech.ended
    word++
    if (!this.cancelled) reveal(text.length)
    this.speech = null
  }

  /**
   * 音声エンジンの声に合わせて1文を演じる。
   * 再生時刻からいまの拍を求めて口の形と文字の出し具合を決め、開き具合は実際に鳴っている音の大きさで決める
   * （息継ぎや読点で声が止まれば、口も自然に閉じる）
   */
  private async performWithAudio(text: string, speech: SpeechHandle, track: AudioTrack): Promise<void> {
    let ended = false
    void speech.ended.then(() => {
      ended = true
    })
    const moras = track.moras
    // 文字の出し具合は、声のある拍の数に対する進み具合で決める
    const voicedBefore: number[] = []
    let voiced = 0
    for (const m of moras) {
      voicedBefore.push(voiced)
      if (m.vowel !== 'pau') voiced++
    }
    let revealed = 0
    const reveal = (count: number) => {
      const end = Math.min(count, text.length)
      if (end > revealed) {
        this.emit(text.slice(revealed, end))
        revealed = end
      }
    }

    while (!ended && !this.cancelled) {
      const t = (performance.now() - track.startedAt) / 1000
      let index = moras.findIndex((m) => t < m.at + m.duration)
      if (index < 0) index = moras.length - 1
      const mora = moras[index]
      if (mora && voiced > 0) {
        const within = mora.vowel === 'pau' ? 0 : Math.min(1, Math.max(0, (t - mora.at) / mora.duration))
        reveal(Math.ceil((text.length * ((voicedBefore[index] ?? 0) + within)) / voiced))
      }
      const shape = mora ? visemeForVowel(mora.vowel) : null
      const open = Math.min(1, Math.max(0, (track.level() - AUDIO_LEVEL_FLOOR) * AUDIO_LEVEL_GAIN))
      if (shape && open > 0.05) this.avatar.setMouth(shape.viseme, open * shape.scale * AUDIO_MAX_OPEN)
      else this.avatar.setMouth(null, 0)
      await this.wait(AUDIO_FRAME_MS)
    }
    if (!this.cancelled) reveal(text.length)
    this.avatar.setMouth(null, 0)
    this.speech = null
  }

  /** 1単語ぶん口を動かし、最後は閉じる。isCurrent() が偽になったらやめる */
  private async mouthWord(word: string, rate: number, isCurrent: () => boolean): Promise<void> {
    let prev: Viseme | null = null
    for (const ch of word) {
      for (const step of planChar(ch, prev)) {
        if (this.cancelled || !isCurrent()) return
        if (step.viseme) prev = step.viseme
        await this.mouthStep(step, rate, isCurrent)
      }
    }
    // 次の単語までの間（息継ぎ・句読点）は口を閉じる
    if (isCurrent()) this.avatar.setMouth(null, 0)
  }

  /**
   * 時間での文字送り。rate が大きいほど速く送る。
   * show を渡すと、文字は onText ではなく show(何文字目まで出すか) で出す
   */
  private async type(text: string, rate: number, show?: (count: number) => void): Promise<void> {
    let prev: Viseme | null = null
    let count = 0
    for (const ch of text) {
      if (this.cancelled) return
      count += ch.length
      if (show) show(count)
      else this.emit(ch)
      for (const step of planChar(ch, prev)) {
        if (this.cancelled) return
        if (step.viseme) prev = step.viseme
        await this.mouthStep(step, rate)
      }
    }
  }

  /** 1拍ぶん口を動かす。isCurrent() が拍の途中で偽になったら、後半の口形は出さない */
  private async mouthStep(step: MouthStep, rate: number, isCurrent: () => boolean = () => true): Promise<void> {
    const duration = step.duration / rate
    if (!step.viseme) {
      this.avatar.setMouth(null, 0)
      await this.wait(duration)
      return
    }
    this.avatar.setMouth(step.viseme, step.weight)
    await this.wait(duration * MORA_HOLD_RATIO)
    if (!isCurrent()) return
    this.avatar.setMouth(step.viseme, step.weight * MORA_RELAX)
    await this.wait(duration * (1 - MORA_HOLD_RATIO))
  }
}

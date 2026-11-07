import type { AgentVoice, Emotion } from '@aicarnation/shared'
import type { EngineStyle } from './engines'

/** 音声エンジンに渡す声の調子 */
export interface EngineTone {
  /** 話す速さ（1 が標準） */
  speed: number
  /** 抑揚の強さ（AivisSpeech の intonationScale。0〜2） */
  intonation: number
  /** テンポの緩急（AivisSpeech の tempoDynamicsScale。0〜2） */
  tempo: number
}

/**
 * 感情ごとに、声の設定へ掛ける倍率。
 * 得意げ・驚きは抑揚を強く弾ませ、悲しみ（本音）は控えめにゆっくり、くつろぎは少し落ち着かせる
 */
const EMOTION_TONE: Record<Emotion, EngineTone> = {
  happy: { speed: 1.03, intonation: 1.25, tempo: 1.15 },
  surprised: { speed: 1.05, intonation: 1.3, tempo: 1.2 },
  angry: { speed: 1.02, intonation: 1.2, tempo: 1.1 },
  sad: { speed: 0.93, intonation: 0.75, tempo: 0.85 },
  relaxed: { speed: 0.97, intonation: 0.9, tempo: 0.9 },
  neutral: { speed: 1, intonation: 1, tempo: 1 },
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** 声の設定と文の感情から、音声エンジンに渡す調子を決める */
export function engineTone(voice: AgentVoice, emotion: Emotion | null): EngineTone {
  const base = { speed: voice.rate, intonation: voice.intonation ?? 1, tempo: voice.tempo ?? 1 }
  const k = voice.emotional === false || !emotion ? EMOTION_TONE.neutral : EMOTION_TONE[emotion]
  return {
    speed: clamp(base.speed * k.speed, 0.5, 2),
    intonation: clamp(base.intonation * k.intonation, 0, 2),
    tempo: clamp(base.tempo * k.tempo, 0, 2),
  }
}

/**
 * 感情ごとのスタイルの名前に含まれやすい言葉。
 * 声のモデルに感情ごとのスタイル（「喜び」「悲しみ」など）があれば、そのスタイルで話す
 */
const STYLE_WORDS: Record<Exclude<Emotion, 'neutral'>, string[]> = {
  happy: ['喜び', '嬉し', 'うれし', '楽し', 'たのし', 'ハッピー', 'あまあま', 'happy', 'joy'],
  surprised: ['驚き', 'おどろ', 'びっくり', 'surprise'],
  angry: ['怒り', 'おこ', 'ツンツン', '不機嫌', 'angry'],
  sad: ['悲しみ', '悲し', 'かなし', 'せつな', '切な', '泣き', 'sad'],
  relaxed: ['おちつき', '落ち着', '穏やか', 'おだやか', 'ささやき', 'relax', 'calm'],
}

/**
 * 感情に合うスタイル。選んでいる声と同じ話者のスタイルから、名前で探す。
 * 合うものが無い・感情が無い・ふつうのときは、選んでいるスタイルのまま
 */
export function emotionStyleFor(styleId: number, emotion: Emotion | null, styles: readonly EngineStyle[]): number {
  if (!emotion || emotion === 'neutral') return styleId
  const current = styles.find((s) => s.styleId === styleId)
  if (!current) return styleId
  const words = STYLE_WORDS[emotion].map((w) => w.toLowerCase())
  const match = styles.find(
    (s) => s.speaker === current.speaker && words.some((w) => s.style.toLowerCase().includes(w)),
  )
  return match?.styleId ?? styleId
}

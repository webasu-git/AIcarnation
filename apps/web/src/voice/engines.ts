import { IS_COMPANION, withToken } from '../runtime'
import { reactive } from 'vue'
import { EngineWarmup, type EngineStatus } from './engineWarmup'
import type { EngineTone } from './tone'

/**
 * ローカル音声エンジン（AivisSpeech。VOICEVOX 互換の HTTP API）。
 * 開発サーバー・同梱サーバーが /tts/<engine>/ でエンジンへ中継する。
 * 声は AivisSpeech の音声合成モデル（.aivmx）として利用者が入れる（アプリは声を持たない）
 */
export type EngineId = 'aivis'

export const ENGINES: readonly { id: EngineId; label: string; hint: string }[] = [
  { id: 'aivis', label: 'AivisSpeech', hint: '自然で表情のある声' },
]

const URI_PREFIX = 'engine:'

/** エージェントの voice.voiceURI に保存する形：engine:<エンジン>:<スタイルID> */
export function engineVoiceURI(engine: EngineId, styleId: number): string {
  return `${URI_PREFIX}${engine}:${styleId}`
}

/** エンジンの声なら、エンジンとスタイル ID。ブラウザの声は null */
export function parseEngineVoiceURI(uri: string): { engine: EngineId; styleId: number } | null {
  const m = uri.match(/^engine:(aivis):(\d+)$/)
  return m ? { engine: m[1] as EngineId, styleId: Number(m[2]) } : null
}

function url(engine: EngineId, path: string): string {
  return withToken(`/tts/${engine}${path}`)
}

/** エンジンへのリクエスト。つながらない・中継が 502 を返すときは「起動していません」にする */
async function engineFetch(engine: EngineId, path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url(engine, path), init)
  } catch {
    throw new Error('起動していません')
  }
  if (res.status === 502 || res.status === 504) throw new Error('起動していません')
  return res
}

/** エンジンが答えるか（つながらなければ、同梱サーバーが起動を頼む） */
async function engineIsUp(engine: EngineId): Promise<boolean> {
  try {
    return (await engineFetch(engine, '/version')).ok
  } catch {
    return false
  }
}

/** 同梱サーバーが知っている、エンジンの起動の様子（開発サーバーなど、知らせが無ければ unknown） */
async function engineState(engine: EngineId): Promise<string> {
  const res = await fetch(withToken('/companion/engine'))
  if (!res.ok) return 'unknown'
  const states = (await res.json()) as Partial<Record<EngineId, string>> | null
  return states?.[engine] ?? 'unknown'
}

/** エンジンの様子（小窓の下のバーに出す） */
export const engineStatus = reactive<Record<EngineId, EngineStatus>>({ aivis: 'unknown' })

/** 話す前にエンジンを起こしておく（画面を開いたときに起こし始め、読み上げは起動を待つ） */
export const engineWarmup = new EngineWarmup({
  isUp: engineIsUp,
  state: engineState,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  onChange: (engine, state) => {
    engineStatus[engine] = state
  },
})

/**
 * エンジンを起動し直す（同梱版だけ）。エンジンを起動した Claude Code の mod が、エンジンを止めてから起動し直す。
 * 声のモデルの一覧が正しく出ないときに使う。起動し直したら、使えるようになるまで待つ（使えれば true）
 */
export async function restartEngine(engine: EngineId): Promise<boolean> {
  if (!IS_COMPANION) throw new Error('再起動は、プラグインから開いた画面でのみ行えます')
  const tooOld = 'アバターを起動した Claude Code が古いバージョンのままです。その Claude Code を開き直してから、もう一度お試しください'
  let res: Response
  try {
    res = await fetch(withToken('/companion/engine/restart'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine }),
    })
  } catch {
    throw new Error('アバターのサーバーに接続できません')
  }
  if (res.status === 404) throw new Error(tooOld)
  if (!res.ok) throw new Error('再起動を依頼できませんでした')
  // 受け付けた（restarting・stopped）→ 起動し直した（starting）の順に進むのを待つ
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (states: string[], ms: number): Promise<string | null> => {
    for (const until = Date.now() + ms; Date.now() < until; await sleep(500)) {
      const state = await engineState(engine).catch(() => 'unknown')
      if (states.includes(state)) return state
    }
    return null
  }
  if (!(await waitFor(['restarting', 'stopped'], 10_000))) throw new Error(tooOld)
  const next = await waitFor(['starting', 'missing'], 40_000)
  if (next === 'missing') throw new Error('AivisSpeech が見つかりません')
  if (!next) throw new Error('AivisSpeech を止められませんでした')
  knownStyles.delete(engine)
  engineWarmup.markDown(engine)
  return engineWarmup.warmUp(engine)
}

export interface EngineStyle {
  styleId: number
  speaker: string
  style: string
  /** AivisSpeech に最初から入っている声（コハク・まおなど）か */
  isDefault?: boolean
}

/** エンジンの話者とスタイルの一覧。エンジンが起動していなければ例外 */
export async function listEngineStyles(engine: EngineId): Promise<EngineStyle[]> {
  const res = await engineFetch(engine, '/speakers')
  if (!res.ok) throw new Error('起動していません')
  const speakers = (await res.json()) as { name: string; speaker_uuid?: string; styles: { name: string; id: number }[] }[]
  const defaults = await defaultSpeakerUuids(engine)
  const styles = speakers
    .flatMap((s) =>
      s.styles.map((st) => ({
        styleId: st.id,
        speaker: s.name,
        style: st.name,
        isDefault: !!s.speaker_uuid && defaults.has(s.speaker_uuid),
      })),
    )
    // 自分で入れた声を先に、最初から入っている声を後に並べる（並びはそれぞれの中で元のまま）
    .sort((a, b) => Number(a.isDefault) - Number(b.isDefault))
  knownStyles.set(engine, Promise.resolve(styles))
  return styles
}

/** 最初から入っている声のモデルの話者（uuid）。モデルの一覧を読めなければ空（区別しない） */
async function defaultSpeakerUuids(engine: EngineId): Promise<Set<string>> {
  try {
    const res = await engineFetch(engine, '/aivm_models')
    if (!res.ok) return new Set()
    const infos = (await res.json()) as Record<string, { is_default_model?: boolean; manifest?: { speakers?: { uuid?: string }[] } }>
    return new Set(
      Object.values(infos)
        .filter((info) => info.is_default_model)
        .flatMap((info) => (info.manifest?.speakers ?? []).map((s) => s.uuid ?? ''))
        .filter(Boolean),
    )
  } catch {
    return new Set()
  }
}

/** 読み上げのたびに話者の一覧を聞かないよう、覚えておく（声のモデルを出し入れしたら忘れる） */
const knownStyles = new Map<EngineId, Promise<EngineStyle[]>>()

/** 覚えている話者の一覧（無ければ聞く。聞けなければ空） */
export function cachedEngineStyles(engine: EngineId): Promise<EngineStyle[]> {
  let styles = knownStyles.get(engine)
  if (!styles) {
    styles = listEngineStyles(engine).catch(() => {
      knownStyles.delete(engine)
      return []
    })
    knownStyles.set(engine, styles)
  }
  return styles
}

export function forgetEngineStyles(): void {
  knownStyles.clear()
}

/** 拍（モーラ）ひとつ。length は秒。0 のときは長さが分からない（AivisSpeech） */
export interface EngineMora {
  vowel: string
  length: number
}

export interface Synthesized {
  audio: ArrayBuffer
  moras: EngineMora[]
  /** 音声の前後の無音（秒） */
  pre: number
  post: number
}

interface AudioQuery {
  accent_phrases: {
    moras: { vowel: string; consonant_length: number | null; vowel_length: number }[]
    pause_mora: { vowel: string; vowel_length: number } | null
  }[]
  speedScale: number
  intonationScale: number
  /** AivisSpeech だけにある項目 */
  tempoDynamicsScale?: number
  pitchScale: number
  prePhonemeLength: number
  postPhonemeLength: number
}

/**
 * 1文を合成する。tone は話す速さ（1 が標準）・抑揚の強さ・テンポの緩急。
 * 声の高さは変えない（AivisSpeech は pitchScale を変えると音質が落ちることがあるため）
 */
export async function synthesize(engine: EngineId, styleId: number, text: string, tone: EngineTone): Promise<Synthesized> {
  const queryRes = await engineFetch(engine, `/audio_query?speaker=${styleId}&text=${encodeURIComponent(text)}`, { method: 'POST' })
  if (!queryRes.ok) throw new Error('読みを作成できませんでした')
  const query = (await queryRes.json()) as AudioQuery
  const rate = tone.speed
  query.speedScale = rate
  query.intonationScale = tone.intonation
  query.tempoDynamicsScale = tone.tempo

  const synthRes = await engineFetch(engine, `/synthesis?speaker=${styleId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  })
  if (!synthRes.ok) throw new Error('音声を作成できませんでした')

  const moras: EngineMora[] = []
  for (const phrase of query.accent_phrases) {
    for (const m of phrase.moras) moras.push({ vowel: m.vowel, length: ((m.consonant_length ?? 0) + m.vowel_length) / rate })
    if (phrase.pause_mora) moras.push({ vowel: 'pau', length: phrase.pause_mora.vowel_length / rate })
  }
  return {
    audio: await synthRes.arrayBuffer(),
    moras,
    pre: query.prePhonemeLength / rate,
    post: query.postPhonemeLength / rate,
  }
}

/** 拍の並びを、音声の中の時刻つきにする */
export interface TimedMora {
  vowel: string
  /** 音声の頭からの開始時刻（秒） */
  at: number
  duration: number
}

/**
 * 拍ごとの長さが分かれば（VOICEVOX 互換のエンジンが返すとき）その長さどおりに並べる。AivisSpeech は長さを返さないので、
 * 音声の長さ（前後の無音を除く）を拍の数で割り振る（息継ぎは少し長めにとる）
 */
export function timeMoras(s: Synthesized, audioDuration: number): TimedMora[] {
  const known = s.moras.some((m) => m.length > 0)
  const weightOf = (m: EngineMora) => (m.vowel === 'pau' ? 1.5 : 1)
  const totalWeight = s.moras.reduce((sum, m) => sum + weightOf(m), 0) || 1
  const span = Math.max(audioDuration - s.pre - s.post, 0.1)
  let at = s.pre
  return s.moras.map((m) => {
    const duration = known ? m.length : (span * weightOf(m)) / totalWeight
    const timed = { vowel: m.vowel, at, duration }
    at += duration
    return timed
  })
}

/** AivisSpeech に入っている音声合成モデル（.aivmx） */
export interface AivmModel {
  uuid: string
  name: string
  /** AivisSpeech に最初から入っているモデルか */
  isDefault: boolean
  /** 作者 */
  creators: string[]
  /** ライセンスの名前（全文の最初の見出し） */
  licenseName: string
  /** ライセンスの全文 */
  licenseText: string
}

/** ライセンスの全文から、名前（最初の見出しか、最初の行）を取り出す */
export function licenseNameOf(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line ? line.replace(/^#+\s*/, '').slice(0, 80) : '（記載なし）'
}

/** 入っている音声合成モデルの一覧。エンジンが起動していなければ例外 */
export async function listAivmModels(): Promise<AivmModel[]> {
  const res = await engineFetch('aivis', '/aivm_models')
  if (!res.ok) throw new Error('モデルの一覧を読み込めませんでした')
  const infos = (await res.json()) as Record<
    string,
    { manifest?: { name?: string; creators?: string[]; license?: string | null }; is_default_model?: boolean }
  >
  return Object.entries(infos).map(([uuid, info]) => {
    const licenseText = info.manifest?.license ?? ''
    return {
      uuid,
      name: info.manifest?.name ?? uuid,
      isDefault: info.is_default_model ?? false,
      creators: info.manifest?.creators ?? [],
      licenseName: licenseNameOf(licenseText),
      licenseText,
    }
  })
}

/** 音声合成モデル（.aivmx）を AivisSpeech に入れる。入れたモデルの声は、すぐ話者の一覧に出る */
export async function installAivmModel(file: File): Promise<void> {
  const form = new FormData()
  form.append('file', file, file.name)
  const res = await engineFetch('aivis', '/aivm_models/install', { method: 'POST', body: form })
  if (!res.ok) {
    const detail = ((await res.json().catch(() => null)) as { detail?: unknown } | null)?.detail
    throw new Error(typeof detail === 'string' ? detail : `${file.name} を追加できませんでした（${res.status}）`)
  }
  forgetEngineStyles()
}

/** 音声合成モデルを AivisSpeech から外す */
export async function uninstallAivmModel(uuid: string): Promise<void> {
  const res = await engineFetch('aivis', `/aivm_models/${encodeURIComponent(uuid)}/uninstall`, { method: 'DELETE' })
  if (!res.ok) throw new Error('モデルを外せませんでした')
  forgetEngineStyles()
}

/** 読みの辞書の言葉（AivisSpeech のユーザー辞書） */
export interface DictWord {
  uuid: string
  /** 表記（例：東雲） */
  surface: string
  /** 読み（カタカナ） */
  pronunciation: string
  /** アクセントの位置（下がる直前の拍の番号。0 は下がらない平板） */
  accentType: number
}

/** 辞書の言葉の一覧。エンジンが起動していなければ例外 */
export async function listDictWords(): Promise<DictWord[]> {
  const res = await engineFetch('aivis', '/user_dict')
  if (!res.ok) throw new Error('辞書を読み込めませんでした')
  const words = (await res.json()) as Record<string, { surface: string; pronunciation: string; accent_type: number }>
  return Object.entries(words)
    .map(([uuid, w]) => ({ uuid, surface: w.surface, pronunciation: w.pronunciation, accentType: w.accent_type }))
    .sort((a, b) => a.surface.localeCompare(b.surface, 'ja'))
}

/** 読みは全角カタカナ（ひらがなはカタカナに直す。長音・小さい文字を含む） */
export function toKatakana(text: string): string {
  return text.trim().replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
}

export function isKatakana(text: string): boolean {
  return /^[ァ-ヶー]+$/.test(text)
}

function dictQuery(word: Omit<DictWord, 'uuid'>): string {
  const params = new URLSearchParams({
    surface: word.surface.trim(),
    pronunciation: toKatakana(word.pronunciation),
    accent_type: String(word.accentType),
    word_type: 'PROPER_NOUN',
  })
  return params.toString()
}

async function dictError(res: Response, fallback: string): Promise<Error> {
  const detail = ((await res.json().catch(() => null)) as { detail?: unknown } | null)?.detail
  return new Error(typeof detail === 'string' ? detail : `${fallback}（${res.status}）`)
}

/** 辞書に言葉を足す。足した言葉は、次に合成する文から効く */
export async function addDictWord(word: Omit<DictWord, 'uuid'>): Promise<void> {
  const res = await engineFetch('aivis', `/user_dict_word?${dictQuery(word)}`, { method: 'POST' })
  if (!res.ok) throw await dictError(res, '辞書に登録できませんでした')
}

export async function updateDictWord(word: DictWord): Promise<void> {
  const res = await engineFetch('aivis', `/user_dict_word/${encodeURIComponent(word.uuid)}?${dictQuery(word)}`, { method: 'PUT' })
  if (!res.ok) throw await dictError(res, '辞書の言葉を修正できませんでした')
}

export async function removeDictWord(uuid: string): Promise<void> {
  const res = await engineFetch('aivis', `/user_dict_word/${encodeURIComponent(uuid)}`, { method: 'DELETE' })
  if (!res.ok) throw await dictError(res, '辞書から削除できませんでした')
}

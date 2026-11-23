import type { AgentBackground, AgentDefinition, AgentMissing, AgentVoice } from '@aicarnation/shared'
import type { EngineStyle } from '../voice/engines'
import { engineVoiceURI, parseEngineVoiceURI } from '../voice/engines'

/**
 * キャラクターの書き出しファイル（設定だけ）。人格・声の設定・動きの割り当て（役とファイル名）・読みの辞書・背景とアイコンの見せ方を入れ、
 * 3D モデル・動きのファイル・声のモデル・背景とアイコンの画像は入れない（素材は利用者が用意する。ファイルが大きくなり、素材の再配布にもなるため）。
 * 読み込んだ側では、足りない素材を「入れてください」と案内する
 */
export const CHARACTER_FORMAT = 'aicarnation-character'

/** 書き出すキャラクターの設定（ID・日時・ファイルの参照は入れない） */
export type CharacterFields = Pick<
  AgentDefinition,
  'name' | 'firstPerson' | 'tone' | 'personality' | 'background' | 'topics' | 'forbidden' | 'systemPrompt' | 'appearance'
>

export interface CharacterFile {
  format: typeof CHARACTER_FORMAT
  version: 1
  exportedAt: string
  character: CharacterFields
  /** 声の設定。AivisSpeech の声は、読み込む側で同じ話者・スタイルを探すために名前も入れる */
  voice: { rate: number; pitch: number; intonation?: number; tempo?: number; emotional?: boolean; speaker?: string; style?: string }
  /** 使っていた VRM のファイル名（ファイルそのものは入れない） */
  vrmFileName: string | null
  /** 使っていた動き（役とファイル名。ファイルそのものは入れない） */
  motions: { role: string; name: string }[]
  /** 読みの辞書（AivisSpeech のユーザー辞書） */
  dictionary: { surface: string; pronunciation: string; accentType: number }[]
  /** 背景（単色の色か、画像・動画のファイル名と見せ方。ファイルそのものは入れない） */
  backdrop?:
    | { kind: 'color'; color: string }
    | ({ kind: 'image'; name: string; media: 'image' | 'video' } & Partial<Omit<Extract<AgentBackground, { kind: 'image' }>, 'kind' | 'fileId' | 'name' | 'media'>>)
  /** アイコンの画像のファイル名と、丸の中の位置・拡大（画像そのものは入れない） */
  icon?: { name: string; x: number; y: number; zoom: number }
  /** 動きの切り替え（腰回りを崩れにくくする・話すときの手ぶり）。無ければオン */
  steadyWaist?: boolean
  talkGestures?: boolean
}

export interface ExportInfo {
  vrmFileName: string | null
  /** 声が AivisSpeech のとき、その話者とスタイル */
  engineStyle: EngineStyle | null
  dictionary: CharacterFile['dictionary']
}

export function makeCharacterFile(agent: AgentDefinition, info: ExportInfo, now = new Date()): CharacterFile {
  const { name, firstPerson, tone, personality, background, topics, forbidden, systemPrompt, appearance } = agent
  const { rate, pitch, intonation, tempo, emotional } = agent.voice
  return {
    format: CHARACTER_FORMAT,
    version: 1,
    exportedAt: now.toISOString(),
    character: { name, firstPerson, tone, personality, background, topics, forbidden, systemPrompt, appearance },
    voice: {
      rate,
      pitch,
      intonation,
      tempo,
      emotional,
      ...(info.engineStyle ? { speaker: info.engineStyle.speaker, style: info.engineStyle.style } : {}),
    },
    vrmFileName: info.vrmFileName,
    motions: Object.entries(agent.motions ?? {}).flatMap(([role, list]) => (list ?? []).map((m) => ({ role, name: m.name }))),
    dictionary: info.dictionary,
    ...(agent.backdrop
      ? {
          backdrop:
            agent.backdrop.kind === 'color'
              ? { kind: 'color' as const, color: agent.backdrop.color }
              : (({ fileId: _fileId, ...rest }) => rest)(agent.backdrop),
        }
      : {}),
    ...(agent.icon ? { icon: { name: agent.icon.name, x: agent.icon.x, y: agent.icon.y, zoom: agent.icon.zoom } } : {}),
    ...(agent.steadyWaist === false ? { steadyWaist: false } : {}),
    ...(agent.talkGestures === false ? { talkGestures: false } : {}),
  }
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** 数で、min〜max に収まっているか（NaN・無限大は通さない） */
const inRange = (v: unknown, min: number, max: number): v is number => isFiniteNumber(v) && v >= min && v <= max
/** 色の番号（#rgb・#rrggbb・#rrggbbaa）。背景の色は、画面の色選びとこの形だけを使う */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** 読み込んだ JSON がキャラクターの書き出しファイルか確かめる。だめなら理由を投げる */
export function parseCharacterFile(data: unknown): CharacterFile {
  const f = data as Partial<CharacterFile> | null
  if (!f || f.format !== CHARACTER_FORMAT || f.version !== 1) throw new Error('キャラクターの書き出しファイルではありません')
  const c = f.character as Partial<CharacterFields> | undefined
  const textKeys = ['name', 'firstPerson', 'tone', 'personality', 'background', 'systemPrompt', 'appearance'] as const
  if (!c || textKeys.some((k) => !isString(c[k])) || !isStringArray(c.topics) || !isStringArray(c.forbidden)) {
    throw new Error('キャラクターの設定の形が正しくありません')
  }
  if (!c.name?.trim()) throw new Error('名前が空です')
  const v = f.voice as Partial<Record<string, unknown>> | undefined
  // 声の数値は、画面で選べる範囲の数だけを受け付ける（0 や極端な値・数でない値が入ると、その声で話せなくなる）
  if (
    !v ||
    !inRange(v.rate, 0.5, 2) ||
    !inRange(v.pitch, 0, 2) ||
    (v.intonation !== undefined && !inRange(v.intonation, 0, 2)) ||
    (v.tempo !== undefined && !inRange(v.tempo, 0, 2)) ||
    (v.emotional !== undefined && typeof v.emotional !== 'boolean') ||
    (v.speaker !== undefined && !isString(v.speaker)) ||
    (v.style !== undefined && !isString(v.style))
  ) {
    throw new Error('声の設定の形が正しくありません')
  }
  if (f.vrmFileName !== null && !isString(f.vrmFileName)) throw new Error('VRM のファイル名の形が正しくありません')
  if (!Array.isArray(f.motions) || !f.motions.every((m) => isString(m?.role) && isString(m?.name))) {
    throw new Error('動きの割り当ての形が正しくありません')
  }
  if (
    !Array.isArray(f.dictionary) ||
    !f.dictionary.every((w) => isString(w?.surface) && isString(w?.pronunciation) && typeof w?.accentType === 'number')
  ) {
    throw new Error('読みの辞書の形が正しくありません')
  }
  const b = f.backdrop as Partial<Record<string, unknown>> | undefined
  // 背景の色は、色の番号（#rrggbb など）だけを受け付ける。色はそのままスタイルに入るので、
  // 文字列なら何でも通すと、url(…) を書いたファイルを読み込んだときに、外のサーバーへ通信させられる
  if (
    b !== undefined &&
    !(b.kind === 'color' && isString(b.color) && HEX_COLOR.test(b.color)) &&
    !(b.kind === 'image' && isString(b.name) && (b.media === 'image' || b.media === 'video'))
  ) {
    throw new Error('背景の形が正しくありません')
  }
  const i = f.icon as Partial<Record<string, unknown>> | undefined
  if (i !== undefined && !(isString(i.name) && isFiniteNumber(i.x) && isFiniteNumber(i.y) && isFiniteNumber(i.zoom))) {
    throw new Error('アイコンの形が正しくありません')
  }
  return f as CharacterFile
}

/**
 * 書き出しファイルの声を、この環境の声にする。AivisSpeech の声は、同じ名前の話者・スタイルが入っていればそれを使い、
 * 無ければブラウザの声にして、どの声のモデルが要るかを返す
 */
export function resolveVoice(
  voice: CharacterFile['voice'],
  styles: readonly EngineStyle[],
): { voice: AgentVoice; missing: AgentMissing['voice'] } {
  const base: AgentVoice = {
    voiceURI: '',
    rate: voice.rate,
    pitch: voice.pitch,
    intonation: voice.intonation,
    tempo: voice.tempo,
    emotional: voice.emotional,
  }
  if (!voice.speaker || !voice.style) return { voice: base, missing: undefined }
  const found = styles.find((s) => s.speaker === voice.speaker && s.style === voice.style)
  if (found) return { voice: { ...base, voiceURI: engineVoiceURI('aivis', found.styleId) }, missing: undefined }
  return { voice: base, missing: { speaker: voice.speaker, style: voice.style } }
}

/**
 * 素材を入れたら、足りないものの一覧から消す。VRM を入れた・動きを同じ名前で入れた・AivisSpeech の声を選んだ・アイコンの画像を入れた、のそれぞれで消える。
 * 何も残らなければ undefined
 */
export function pruneMissing(agent: AgentDefinition): AgentMissing | undefined {
  const m = agent.missing
  if (!m) return undefined
  const names = new Set(Object.values(agent.motions ?? {}).flatMap((l) => (l ?? []).map((x) => x.name)))
  const next: AgentMissing = {}
  if (m.vrmFileName && agent.vrm.source !== 'local') next.vrmFileName = m.vrmFileName
  const motions = (m.motions ?? []).filter((x) => !names.has(x.name))
  if (motions.length) next.motions = motions
  if (m.voice && !parseEngineVoiceURI(agent.voice.voiceURI)) next.voice = m.voice
  if (m.backgroundFileName && agent.backdrop?.kind !== 'image') next.backgroundFileName = m.backgroundFileName
  if (m.icon && !agent.icon) next.icon = m.icon
  return Object.keys(next).length ? next : undefined
}

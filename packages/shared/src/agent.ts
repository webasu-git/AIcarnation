/**
 * - local: ユーザーが読み込んだファイル（ref は IndexedDB の vrmFiles キー）
 * - none: まだ入れていない（ref は空）。3D モデルは利用者が入れる
 * - vroidhub: VRoid Hub のモデル（ref はモデルURL。見送り。型だけ残す）
 */
export type VrmSource = 'local' | 'none' | 'vroidhub'

/** モデルがまだ入っていないときの参照 */
export const NO_VRM: AgentVrmRef = { source: 'none', ref: '' }

export interface AgentVrmRef {
  source: VrmSource
  ref: string
}

export interface AgentVoice {
  voiceURI: string
  rate: number
  pitch: number
  /** 音声エンジンの抑揚の強さ（0〜2、無ければ 1）。AivisSpeech では選んだスタイルの感情の強さ */
  intonation?: number
  /** 音声エンジンのテンポの緩急（0〜2、無ければ 1） */
  tempo?: number
  /** 感情タグに合わせて声の調子を変えるか（無ければ変える） */
  emotional?: boolean
}

/** 動きの役に割り当てたファイル1つ（保存したファイルの id と、元のファイル名） */
export interface AgentMotionRef {
  fileId: string
  name: string
}

/** 動きの役（idle・greet など）ごとに割り当てたファイル（パターン。再生のたびに乱数で1つ選ぶ） */
export type AgentMotions = Partial<Record<string, AgentMotionRef[]>>

/**
 * キャラクターの背景。
 * - color：単色
 * - image：画像か動画を、縦横比を保ったままステージいっぱいに敷く（2D）
 */
export type AgentBackground =
  | { kind: 'color'; color: string }
  | {
      kind: 'image'
      /** 保存したファイルの id と、元のファイル名 */
      fileId: string
      name: string
      media: 'image' | 'video'
      /** 見せる中心（0〜1。0.5 が真ん中。はみ出た部分を切るときに、どこを残すか） */
      focusX: number
      focusY: number
      /** 拡大（1〜3） */
      zoom: number
      /** 明るさ（0.2〜1.5） */
      brightness: number
      /** ぼかし（0〜10。画像だけ） */
      blur: number
      /** カメラを回すと背景が少しずれる（奥行き感） */
      parallax: boolean
    }

/**
 * キャラクターの一覧などに出す丸いアイコンの画像（無ければ名前の頭文字）。
 * 元の画像を保存し、どこを丸の真ん中に置くかと拡大を覚える（あとから位置を直せるように）
 */
export interface AgentIcon {
  /** 保存したファイルの id と、元のファイル名 */
  fileId: string
  name: string
  /** 丸の真ん中に置く画像の位置（0〜1。0.5 が画像の真ん中） */
  x: number
  y: number
  /** 拡大（1 で丸がちょうど画像で埋まる。最大 4） */
  zoom: number
}

/** 背景が決まっていないときの単色 */
export const DEFAULT_BACKGROUND_COLOR = '#e8eef5'

/**
 * 書き出したキャラクターを読み込んだとき、まだ入っていない素材（ファイルは書き出しに含めないので、利用者に入れてもらう）。
 * 入れたものから消える
 */
export interface AgentMissing {
  /** 元の環境で使っていた VRM のファイル名 */
  vrmFileName?: string
  /** 元の環境で使っていた動き（役とファイル名）。同じ名前のファイルを入れると、その役に入る */
  motions?: { role: string; name: string }[]
  /** 元の環境で使っていた声（AivisSpeech の話者とスタイルの名前） */
  voice?: { speaker: string; style: string }
  /** 元の環境で背景に使っていた画像・動画のファイル名 */
  backgroundFileName?: string
  /** 元の環境でアイコンに使っていた画像のファイル名と、丸の中の位置・拡大（同じ名前の画像を選ぶと位置も戻す） */
  icon?: { name: string; x: number; y: number; zoom: number }
}

/** エージェント定義 */
export interface AgentDefinition {
  id: string
  name: string
  firstPerson: string
  tone: string
  personality: string
  background: string
  topics: string[]
  forbidden: string[]
  /** 上記を統合した本文。感情タグの指示を含む */
  systemPrompt: string
  /** 髪色・髪型・服装・雰囲気。将来のVRM生成との接続用 */
  appearance: string
  vrm: AgentVrmRef
  voice: AgentVoice
  /** 動きのファイルの割り当て（キャラクターごと。無ければコードの動きだけで動く） */
  motions?: AgentMotions
  /** 腰回りを崩れにくくする（背骨の回転の多くを胸へ移す）。無ければオン */
  steadyWaist?: boolean
  /** 話している間に手ぶりをする（両手を開いて見せる）。モデルによって手が体や服にめり込むときに切る。無ければオン */
  talkGestures?: boolean
  /** ステージの背景（キャラクターごと。無ければ既定の単色。人物の背景 background とは別） */
  backdrop?: AgentBackground
  /** 一覧などに出す丸いアイコンの画像（無ければ名前の頭文字） */
  icon?: AgentIcon
  /** 読み込んだキャラクターで、まだ入っていない素材 */
  missing?: AgentMissing
  /** ISO8601 */
  createdAt: string
  /** ISO8601 */
  updatedAt: string
}

/** /agents/generate が返す部分（ID・見た目のファイル・声・日時はフロントで決める） */
export type GeneratedAgent = Pick<
  AgentDefinition,
  'name' | 'firstPerson' | 'tone' | 'personality' | 'background' | 'topics' | 'forbidden' | 'systemPrompt' | 'appearance'
>

export const AGENT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
export type AgentImageType = (typeof AGENT_IMAGE_TYPES)[number]

/** エージェント生成に渡す画像。生成にだけ使い、保存しない */
export interface AgentImage {
  mediaType: AgentImageType
  /** base64（data: の接頭辞なし） */
  data: string
}

/** 説明文・画像のどちらか、または両方 */
export interface GenerateAgentRequest {
  description?: string
  images?: AgentImage[]
}

export const MAX_AGENT_DESCRIPTION_CHARS = 2000

/**
 * エージェントの定義を作るときの、話し方を残すための決まり。
 * 説明文に書いた口癖や例文が、作るときに要約されて消えないようにする（口調をまねさせるのに例文がよく効くため）。
 * 同梱版の mod（plugins/aicarnation/hooks/register.ts）にも同じ文を写している
 */
export const AGENT_SPEECH_RULES = `説明に口癖・語尾・合いの手・決まった言い回し・話し方の例文が書かれていたら、要約したり言い換えたりせず、書かれた言葉のまま tone と systemPrompt に残す。
systemPrompt の終わり近く（「返答は1〜3文」の指示の前）に「話し方の例：」として、説明にある例文を書かれたとおりに並べる（最大5つ）。説明に例文が無ければ、口調に合う短い例文を3つ作って並べる。
例文のすぐ後に「例文はそのまま繰り返さず、この調子をまねて話す」ことも書く。`
/** 入力制限：画像は1枚5MB・最大3枚 */
export const MAX_AGENT_IMAGES = 3
export const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024

/** base64 文字列が表すバイト数 */
export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/** 声の推薦に渡す、ブラウザで使える声 */
export interface VoiceOption {
  voiceURI: string
  name: string
  lang: string
}

export interface SuggestVoiceRequest {
  agent: Pick<AgentDefinition, 'name' | 'firstPerson' | 'tone' | 'personality' | 'appearance'>
  voices: VoiceOption[]
}

export interface SuggestVoiceResponse {
  voiceURI: string
  reason: string
}

export const MAX_VOICE_OPTIONS = 80
/** 定義JSONの最大サイズ（D1 同期・JSON 読み込み） */
export const MAX_AGENT_JSON_BYTES = 32 * 1024

export const DEFAULT_VOICE: AgentVoice = { voiceURI: '', rate: 1, pitch: 1 }

const STRING_FIELDS = ['id', 'name', 'firstPerson', 'tone', 'personality', 'background', 'systemPrompt', 'appearance', 'createdAt', 'updatedAt'] as const
const VRM_SOURCES: readonly string[] = ['local', 'none', 'vroidhub']

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

/**
 * エージェント定義の形を検証する（JSON 読み込み・D1 同期で使う）。問題があれば理由を返す
 */
export function validateAgentDefinition(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return '定義がオブジェクトではありません'
  const v = value as Record<string, unknown>
  for (const key of STRING_FIELDS) {
    if (typeof v[key] !== 'string') return `${key} がありません`
  }
  if ((v.name as string).trim() === '') return '名前が空です'
  if (!isStringArray(v.topics)) return 'topics が文字列の配列ではありません'
  if (!isStringArray(v.forbidden)) return 'forbidden が文字列の配列ではありません'
  const vrm = v.vrm as Record<string, unknown> | undefined
  if (typeof vrm !== 'object' || vrm === null || !VRM_SOURCES.includes(vrm.source as string) || typeof vrm.ref !== 'string') {
    return 'vrm の指定が不正です'
  }
  const voice = v.voice as Record<string, unknown> | undefined
  if (
    typeof voice !== 'object' ||
    voice === null ||
    typeof voice.voiceURI !== 'string' ||
    typeof voice.rate !== 'number' ||
    typeof voice.pitch !== 'number'
  ) {
    return 'voice の指定が不正です'
  }
  if (v.motions !== undefined && !isAgentMotions(v.motions)) return 'motions の指定が不正です'
  if (v.missing !== undefined && (typeof v.missing !== 'object' || v.missing === null)) return 'missing の指定が不正です'
  if (v.backdrop !== undefined && !isAgentBackground(v.backdrop)) return 'backdrop の指定が不正です'
  if (v.icon !== undefined && !isAgentIcon(v.icon)) return 'icon の指定が不正です'
  return null
}

function isAgentIcon(value: unknown): value is AgentIcon {
  const i = value as Partial<Record<string, unknown>> | null
  return (
    typeof i === 'object' &&
    i !== null &&
    typeof i.fileId === 'string' &&
    typeof i.name === 'string' &&
    typeof i.x === 'number' &&
    typeof i.y === 'number' &&
    typeof i.zoom === 'number'
  )
}

function isAgentMotions(value: unknown): value is AgentMotions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every(
    (list) =>
      list === undefined ||
      (Array.isArray(list) &&
        list.every((m) => typeof m === 'object' && m !== null && typeof m.fileId === 'string' && typeof m.name === 'string')),
  )
}

function isAgentBackground(value: unknown): value is AgentBackground {
  const b = value as Partial<Record<string, unknown>> | null
  if (typeof b !== 'object' || b === null) return false
  if (b.kind === 'color') return typeof b.color === 'string'
  if (b.kind !== 'image') return false
  return typeof b.fileId === 'string' && typeof b.name === 'string' && (b.media === 'image' || b.media === 'video')
}

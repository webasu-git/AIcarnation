/**
 * Claude 連携（ブリッジ）。Claude Code の mod が送る合図と、アバターに渡すキャラクター設定の型。
 * 受け口は Vite の開発サーバー（apps/web/bridge）にあり、手元でだけ動く。
 */

/** mod が POST するときに必ず付けるヘッダー。ブラウザから別のオリジンで送れないようにするため */
export const BRIDGE_HEADER = 'x-aicarnation-bridge'

export const MAX_BRIDGE_TEXT_CHARS = 2000

export type BridgeEvent =
  /** あなたが Claude Code に話しかけた */
  | { type: 'listening'; text: string }
  /** Claude Code が作業している（ツールを使っている） */
  | { type: 'working'; label: string }
  /** Claude Code の返答を、アバターが話す短い文にしたもの（感情タグ付き） */
  | { type: 'reply'; text: string }
  /** 返答が中断・失敗して終わった */
  | { type: 'idle' }
  /** Claude Code で起きた出来事。アバターが一言反応する（台詞帳から選ぶ） */
  | { type: 'notice'; kind: NoticeKind }

/**
 * mod が知らせる出来事
 * - command-failed：コマンドが失敗した
 * - tests-passed / tests-failed：テストが通った・失敗した
 */
export const NOTICE_KINDS = ['command-failed', 'tests-passed', 'tests-failed'] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

/** mod が要約の口調に使う、選択中のエージェントの人柄 */
export interface BridgePersona {
  name: string
  firstPerson: string
  tone: string
  personality: string
}

/** 中身ごと消す、Claude Code が足す内部メモのタグ */
const HIDDEN_BLOCKS = ['system-reminder', 'local-command-caveat', 'local-command-stdout', 'command-name', 'command-message', 'command-args']

/**
 * Claude Code への入力を、吹き出しに出せる自然な文章だけにする。
 * - 内部メモ（<system-reminder> など）は中身ごと消す
 * - 貼り付けの囲み（<pasted_content …>…</pasted_content>）などは外して中の文章を残す
 * - 残ったタグを消し、空白を整える
 */
export function cleanPromptText(text: string): string {
  let out = text
  for (const tag of HIDDEN_BLOCKS) {
    out = out.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'g'), ' ')
  }
  return out
    .replace(/<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

const str = (v: unknown, max = MAX_BRIDGE_TEXT_CHARS): string | null =>
  typeof v === 'string' && v.length <= max ? v : null

/** 届いた合図を検証する。形が違えば null */
export function parseBridgeEvent(value: unknown): BridgeEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  switch (v.type) {
    case 'listening': {
      const text = str(v.text)
      return text === null ? null : { type: 'listening', text }
    }
    case 'working': {
      const label = str(v.label, 100)
      return label === null ? null : { type: 'working', label }
    }
    case 'reply': {
      const text = str(v.text)
      return text === null || text.trim() === '' ? null : { type: 'reply', text }
    }
    case 'idle':
      return { type: 'idle' }
    case 'notice':
      return NOTICE_KINDS.includes(v.kind as NoticeKind) ? { type: 'notice', kind: v.kind as NoticeKind } : null
    default:
      return null
  }
}

export function parseBridgePersona(value: unknown): BridgePersona | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const fields = ['name', 'firstPerson', 'tone', 'personality'] as const
  const out: Partial<BridgePersona> = {}
  for (const f of fields) {
    const s = str(v[f], 500)
    if (s === null) return null
    out[f] = s
  }
  return out as BridgePersona
}

/** 1メッセージの最大文字数 */
export const MAX_MESSAGE_CHARS = 4000
/** 中継APIに送る履歴の上限（往復数） */
export const MAX_HISTORY_TURNS = 20
/** 1リクエストのメッセージ数上限：履歴20往復＋今回のユーザー発言 */
export const MAX_CHAT_MESSAGES = MAX_HISTORY_TURNS * 2 + 1
export const MAX_SYSTEM_PROMPT_CHARS = 8000

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  /** アシスタントの発言は感情タグ付きのまま保存・送信する（Claude にタグの書式を保たせるため） */
  content: string
}

/** POST /chat のリクエスト */
export interface ChatRequest {
  agentId: string
  systemPrompt: string
  messages: ChatMessage[]
}

export type ChatErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'usage_limit'
  | 'refusal'
  | 'upstream_busy'
  | 'upstream_error'

/** /chat の SSE イベント。event 名と data(JSON) の組 */
export type ChatStreamEvent =
  | { event: 'delta'; data: { text: string } }
  | { event: 'done'; data: { stopReason: string | null } }
  | { event: 'error'; data: { code: ChatErrorCode; message: string } }

export interface UsageResponse {
  used: number
  limit: number
  /** 次にリセットされる時刻（ISO8601。日本時間の0時） */
  resetsAt: string
}

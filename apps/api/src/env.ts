export interface Env {
  DB: D1Database
  USAGE: KVNamespace
  ALLOWED_ORIGINS: string
  CHAT_MODEL: string
  GENERATE_MODEL: string
  DAILY_CHAT_LIMIT: string
  /** すべての利用者を合わせた1日の上限（匿名 ID を作り直して上限を逃れても、ここで止まる）。無ければ 1000 */
  DAILY_GLOBAL_LIMIT?: string
  /** Workers Secret（ローカルは .dev.vars）。コード・ログに出さない */
  ANTHROPIC_API_KEY?: string
  /** "true" で API キー無しのモック応答にする（開発用） */
  MOCK_CLAUDE?: string
}

export interface Variables {
  anonId: string
}

export type AppEnv = { Bindings: Env; Variables: Variables }

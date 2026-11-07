/**
 * 動作モード。
 * - 通常：pnpm dev で動かす開発版（中継API・Claude 連携の切り替えあり）
 * - 同梱版（VITE_COMPANION=1）：Claude Code のプラグイン aicarnation に同梱する画面。
 *   同梱サーバーから配信され、Claude 連携は常にオン。モデルの呼び出しは Claude Code 経由で、API キーを使わない
 */
export const IS_COMPANION = import.meta.env.VITE_COMPANION === '1'

const TOKEN_KEY = 'aicarnation.token'

/**
 * 同梱サーバーの合言葉。開いた URL の ?token= から受け取り、再読み込みに備えてタブの間だけ覚える。
 * アドレスバーからは消しておく
 */
function readToken(): string {
  if (!IS_COMPANION) return ''
  const url = new URL(location.href)
  const fromUrl = url.searchParams.get('token')
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl)
    } catch {
      // 覚えられなくても、このページの間は使える
    }
    url.searchParams.delete('token')
    history.replaceState(null, '', url)
    return fromUrl
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

const token = readToken()

/** 同梱サーバーへのリクエストに付けるヘッダー */
export function companionHeaders(): Record<string, string> {
  return token ? { 'x-aicarnation-token': token } : {}
}

/**
 * 合言葉が今の同梱サーバーのものか。Claude Code を開き直すと合言葉が変わるので、
 * 前のセッションで開いた画面を再読み込みしたときは false になる
 */
export async function isCompanionSessionValid(): Promise<boolean> {
  try {
    return (await fetch('/bridge/status', { headers: companionHeaders() })).ok
  } catch {
    return false
  }
}

/** EventSource はヘッダーを付けられないので、合言葉はクエリで渡す */
export function withToken(path: string): string {
  return token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path
}

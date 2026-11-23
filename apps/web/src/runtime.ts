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

/**
 * つなぎ先が本物の同梱サーバー（同じ合言葉を知っている）だと確かめられているか。確かめるまで、合言葉は送らない。
 * サーバーが止まっている間に、同じ PC のほかのプログラムがポートを取ることがある。
 * 確かめずにつなぎ直すと、そのプログラムに合言葉を渡してしまう
 */
let trusted = false

/** 同梱サーバーへのリクエストに付けるヘッダー（つなぎ先を確かめるまでは付けない） */
export function companionHeaders(): Record<string, string> {
  return token && trusted ? { 'x-aicarnation-token': token } : {}
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** 起動確認の署名：使い捨ての値を、合言葉を鍵にして署名したもの（同梱サーバーの healthProof と同じ計算） */
export async function healthProof(secret: string, nonce: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`aicarnation-health:${nonce}`))))
}

/**
 * つなぎ先が本物の同梱サーバーかを確かめる。使い捨ての値を送り、合言葉で署名した答えが返るかを見る
 * （合言葉そのものは送らない）。確かめられたら、以後のリクエストに合言葉を付ける
 */
export async function verifyCompanionServer(): Promise<boolean> {
  trusted = false
  if (!token) return false
  try {
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
    const res = await fetch(`/companion/health?nonce=${nonce}`, { cache: 'no-store' })
    if (!res.ok) return false
    const body = (await res.json()) as { proof?: unknown }
    trusted = typeof body.proof === 'string' && body.proof === (await healthProof(token, nonce))
  } catch {
    trusted = false
  }
  return trusted
}

/** つなぎ先が切れた。確かめ直すまで、合言葉を送らない */
export function distrustCompanionServer(): void {
  trusted = false
}

/**
 * 合言葉が今の同梱サーバーのものか。Claude Code を開き直すと合言葉が変わるので、
 * 前のセッションで開いた画面を再読み込みしたときは false になる
 */
export async function isCompanionSessionValid(): Promise<boolean> {
  try {
    if (!(await verifyCompanionServer())) return false
    return (await fetch('/bridge/status', { headers: companionHeaders() })).ok
  } catch {
    return false
  }
}

/** EventSource はヘッダーを付けられないので、合言葉はクエリで渡す（つなぎ先を確かめるまでは付けない） */
export function withToken(path: string): string {
  return token && trusted ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path
}

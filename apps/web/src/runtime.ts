/**
 * 動作モード。
 * - 通常：pnpm dev で動かす開発版（中継API・Claude 連携の切り替えあり）
 * - 同梱版（VITE_COMPANION=1）：Claude Code のプラグイン aicarnation に同梱する画面。
 *   同梱サーバーから配信され、Claude 連携は常にオン。モデルの呼び出しは Claude Code 経由で、API キーを使わない
 */
export const IS_COMPANION = import.meta.env.VITE_COMPANION === '1'

const TOKEN_KEY = 'aicarnation.token'

/** 開いた URL の券を、合言葉と引き換えられなかった（使い終わった・期限切れ・サーバーが入れ替わった） */
let ticketRefused = false
/** 開いた URL の券が使えなかったか（「この URL は使えなくなりました」と案内するため） */
export async function wasTicketRefused(): Promise<boolean> {
  await tokenReady
  return ticketRefused && !token
}

/** 受け取った合言葉を、再読み込みに備えてタブの間だけ覚える */
function remember(value: string) {
  try {
    sessionStorage.setItem(TOKEN_KEY, value)
  } catch {
    // 覚えられなくても、このページの間は使える
  }
}

/**
 * 同梱サーバーの合言葉。開いた URL の ?ticket=（使い捨ての券）を合言葉と引き換えて受け取り、タブの間だけ覚える。
 * 前の版の mod が開いた ?token= も受け取る。どちらもアドレスバーからは消しておく
 * （合言葉そのものを URL に入れると、Claude Code のセッション記録やブラウザの履歴に残るため、券を使う）
 */
async function readToken(): Promise<string> {
  if (!IS_COMPANION) return ''
  const url = new URL(location.href)
  const ticket = url.searchParams.get('ticket')
  const fromUrl = url.searchParams.get('token')
  if (ticket || fromUrl) {
    url.searchParams.delete('ticket')
    url.searchParams.delete('token')
    history.replaceState(null, '', url)
  }
  if (fromUrl) {
    remember(fromUrl)
    return fromUrl
  }
  if (ticket) {
    ticketRefused = true
    try {
      const res = await fetch('/companion/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }),
        cache: 'no-store',
      })
      const body = res.ok ? ((await res.json()) as { token?: unknown }) : null
      if (typeof body?.token === 'string' && /^[0-9a-f]{16,64}$/.test(body.token)) {
        ticketRefused = false
        remember(body.token)
        return body.token
      }
    } catch {
      // 引き換えられなかった：覚えている合言葉があれば使う（なければ「前のセッションの画面」と案内する）
    }
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

let token = ''
/** 合言葉を受け取り終えたら解決する（券の引き換えを待つ。合言葉を使う処理は、これを待ってから） */
const tokenReady: Promise<void> = readToken().then((value) => {
  token = value
})

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

/** 確かめている最中の問い合わせ（同時に頼まれたら、1 回の確認を分け合う） */
let verifying: Promise<boolean> | null = null
/** 疑い直した回数。確かめている途中で疑い直したら、その確認の結果は使わない */
let distrustCount = 0

/** 起動確認の応答を待つ時間 */
const HEALTH_TIMEOUT_MS = 5000

async function checkServer(): Promise<boolean> {
  try {
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
    // 応答が止まっても、確認を分け合うほかの問い合わせまで止まらないよう、時間を区切る
    const res = await fetch(`/companion/health?nonce=${nonce}`, { cache: 'no-store', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    if (!res.ok) return false
    const body = (await res.json()) as { proof?: unknown }
    return typeof body.proof === 'string' && body.proof === (await healthProof(token, nonce))
  } catch {
    return false
  }
}

/**
 * つなぎ先が本物の同梱サーバーかを確かめる。使い捨ての値を送り、合言葉で署名した答えが返るかを見る
 * （合言葉そのものは送らない）。確かめられたら、以後のリクエストに合言葉を付ける。
 * 確かめている間も、それまでの結果は変えない（ほかの処理の問い合わせが、途中で合言葉なしになって断られないように）。
 * 同時に頼まれたら、同じ確認の結果を返す。確かめている途中で疑い直したら、確かめ直す
 */
export function verifyCompanionServer(): Promise<boolean> {
  if (verifying) return verifying
  const mine = distrustCount
  const check: Promise<boolean> = tokenReady.then(() => (token ? checkServer() : false)).then((ok) => {
    if (verifying === check) verifying = null
    if (mine !== distrustCount) return verifyCompanionServer()
    trusted = ok
    return ok
  })
  verifying = check
  return check
}

/** つなぎ先が切れた。確かめ直すまで、合言葉を送らない（確かめている途中のものの結果も使わない） */
export function distrustCompanionServer(): void {
  trusted = false
  distrustCount++
  verifying = null
}

/** 合言葉の要る問い合わせが断られた（401）ときに呼ぶもの。画面は、合言葉が古くなっていないかを確かめる */
const rejectedListeners = new Set<() => void>()
export function onCompanionRejected(listener: () => void): () => void {
  rejectedListeners.add(listener)
  return () => rejectedListeners.delete(listener)
}

/**
 * 同梱サーバーへの問い合わせ（保存データ・依頼・音声エンジンの中継など、合言葉の要るものはすべてこれを通す）。
 * つなぎ先をまだ確かめていなければ、確かめてから合言葉を付けて送る（確かめられなければ合言葉なしで送り、サーバーが断る）。
 * 開発版（同梱版でない）は、そのまま送る
 */
export async function companionFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!IS_COMPANION) return fetch(path, init)
  if (!trusted) await verifyCompanionServer()
  const headers = new Headers(init.headers)
  for (const [k, v] of Object.entries(companionHeaders())) headers.set(k, v)
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) for (const listener of rejectedListeners) listener()
  return res
}

/**
 * 合言葉が今の同梱サーバーのものか。Claude Code を開き直すと合言葉が変わるので、
 * 前のセッションで開いた画面を再読み込みしたときは false になる
 */
export async function isCompanionSessionValid(): Promise<boolean> {
  try {
    if (!(await verifyCompanionServer())) return false
    return (await companionFetch('/bridge/status')).ok
  } catch {
    return false
  }
}

/** EventSource はヘッダーを付けられないので、合言葉はクエリで渡す（つなぎ先を確かめるまでは付けない） */
export function withToken(path: string): string {
  return token && trusted ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path
}

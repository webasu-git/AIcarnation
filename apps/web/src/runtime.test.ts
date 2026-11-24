import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TOKEN = '0123456789abcdef0123456789abcdef'

/**
 * 同梱版の画面として runtime.ts を読み込む（合言葉は URL から受け取る）。
 * server は、届いたリクエストに答える偽のサーバー（起動確認には、合言葉で署名した値を返す）
 */
async function loadRuntime(server: (url: string, init: RequestInit) => Promise<Response>, query = `token=${TOKEN}`) {
  vi.resetModules()
  vi.stubEnv('VITE_COMPANION', '1')
  const store = new Map<string, string>()
  vi.stubGlobal('location', { href: `http://127.0.0.1:48280/?${query}` })
  vi.stubGlobal('history', { replaceState: () => undefined })
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) })
  const calls: { url: string; token: string | null }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, token: new Headers(init.headers).get('x-aicarnation-token') })
      return server(url, init)
    }),
  )
  const runtime = await import('./runtime')
  return { runtime, calls }
}

/** 本物の同梱サーバーのふり：起動確認には署名を、そのほかには合言葉が付いていれば 200 を返す */
function genuine(healthDelayMs = 0) {
  return async (url: string, init: RequestInit) => {
    if (url.startsWith('/companion/health')) {
      if (healthDelayMs) await new Promise((r) => setTimeout(r, healthDelayMs))
      const { healthProof } = await import('./runtime')
      const nonce = new URL(url, 'http://x').searchParams.get('nonce') ?? ''
      return new Response(JSON.stringify({ app: 'aicarnation', proof: await healthProof(TOKEN, nonce) }))
    }
    return new Response('{}', { status: new Headers(init.headers).get('x-aicarnation-token') === TOKEN ? 200 : 401 })
  }
}

describe('companionFetch', () => {
  beforeEach(() => vi.useRealTimers())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('つなぎ先を確かめてから、合言葉を付けて送る', async () => {
    const { runtime, calls } = await loadRuntime(genuine())
    const res = await runtime.companionFetch('/store/settings/volume')
    expect(res.status).toBe(200)
    expect(calls.map((c) => [c.url.split('?')[0], c.token])).toEqual([
      ['/companion/health', null],
      ['/store/settings/volume', TOKEN],
    ])
  })

  it('確かめ直している最中も、ほかの問い合わせは合言葉付きで通る（起動時に設定が読めなくなっていた不具合）', async () => {
    const { runtime, calls } = await loadRuntime(genuine(30))
    expect(await runtime.verifyCompanionServer()).toBe(true)
    // 接続の処理が確かめ直している間に、設定を読む
    const again = runtime.verifyCompanionServer()
    const reads = await Promise.all(['a', 'b', 'c'].map((k) => runtime.companionFetch(`/store/settings/${k}`)))
    expect(reads.map((r) => r.status)).toEqual([200, 200, 200])
    expect(await again).toBe(true)
    expect(calls.filter((c) => c.url.startsWith('/store/')).every((c) => c.token === TOKEN)).toBe(true)
  })

  it('確かめている途中で疑い直したら、その結果は使わずに確かめ直す', async () => {
    let impostor = false
    const real = genuine(20)
    const { runtime, calls } = await loadRuntime(async (url, init) => {
      if (impostor && url.startsWith('/companion/health')) return new Response(JSON.stringify({ app: 'aicarnation' }))
      return real(url, init)
    })
    const first = runtime.verifyCompanionServer()
    // 確かめている途中で接続が切れ、ほかのプログラムがポートを取った
    runtime.distrustCompanionServer()
    impostor = true
    expect(await first).toBe(false)
    await runtime.companionFetch('/store/settings/volume')
    expect(calls.filter((c) => c.url.startsWith('/store/')).every((c) => c.token === null)).toBe(true)
  })

  it('断られた（401）ことを知らせる', async () => {
    const { runtime } = await loadRuntime(async (url) =>
      url.startsWith('/companion/health') ? new Response('{}', { status: 503 }) : new Response('{}', { status: 401 }),
    )
    const rejected = vi.fn()
    runtime.onCompanionRejected(rejected)
    await runtime.companionFetch('/store/settings/volume')
    expect(rejected).toHaveBeenCalledTimes(1)
  })

  it('URL の使い捨ての券を合言葉と引き換えて使う（合言葉は URL に入れない）', async () => {
    const TICKET = 'ab'.repeat(16)
    const real = genuine()
    const { runtime, calls } = await loadRuntime(async (url, init) => {
      if (url === '/companion/redeem') {
        const body = JSON.parse(String(init.body)) as { ticket?: string }
        return body.ticket === TICKET ? new Response(JSON.stringify({ token: TOKEN })) : new Response('{}', { status: 404 })
      }
      return real(url, init)
    }, `ticket=${TICKET}`)
    const res = await runtime.companionFetch('/store/settings/volume')
    expect(res.status).toBe(200)
    expect(calls[0]?.url).toBe('/companion/redeem')
    expect(calls.at(-1)).toEqual({ url: '/store/settings/volume', token: TOKEN })
  })

  it('券を引き換えられなければ、合言葉を送らない', async () => {
    const { runtime, calls } = await loadRuntime(async (url) => new Response('{}', { status: url === '/companion/redeem' ? 404 : 200 }), `ticket=${'cd'.repeat(16)}`)
    expect(await runtime.verifyCompanionServer()).toBe(false)
    await runtime.companionFetch('/store/settings/volume')
    expect(calls.every((c) => c.token === null)).toBe(true)
  })

  it('同時に頼まれた確認は 1 回にまとめる', async () => {
    const { runtime, calls } = await loadRuntime(genuine(20))
    await Promise.all([runtime.verifyCompanionServer(), runtime.verifyCompanionServer(), runtime.companionFetch('/store/settings/x')])
    expect(calls.filter((c) => c.url.startsWith('/companion/health'))).toHaveLength(1)
  })

  it('署名を返さない相手には、合言葉を送らない', async () => {
    const { runtime, calls } = await loadRuntime(async (url) =>
      url.startsWith('/companion/health') ? new Response(JSON.stringify({ app: 'aicarnation', pid: 1 })) : new Response('{}', { status: 200 }),
    )
    await runtime.companionFetch('/store/settings/volume')
    expect(calls.every((c) => c.token === null)).toBe(true)
  })

  it('切れたあとは、確かめ直してから合言葉を付ける', async () => {
    const { runtime, calls } = await loadRuntime(genuine())
    await runtime.companionFetch('/store/settings/a')
    runtime.distrustCompanionServer()
    await runtime.companionFetch('/store/settings/b')
    expect(calls.map((c) => c.url.split('?')[0])).toEqual(['/companion/health', '/store/settings/a', '/companion/health', '/store/settings/b'])
    expect(calls.at(-1)?.token).toBe(TOKEN)
  })
})

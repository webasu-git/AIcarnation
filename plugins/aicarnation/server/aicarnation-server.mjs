#!/usr/bin/env node
// aicarnation の同梱サーバー（Node 18 以上、追加パッケージなし）。
// mod（hooks/register.ts）がセッション開始時に起動し、セッションが終わると止まる。
//
//   node aicarnation-server.mjs --web <画面のフォルダ> --data <保存先> --token-file <合言葉のファイル> [--port 48280]
//
// - 127.0.0.1 だけで待ち受ける。ポートは 48280 だけを使う。同じ版のサーバーが動いていれば共用し（shared を知らせて終わる）、古い版のサーバーが残っていれば止める
// - GET  /                         … ビルド済みのアバター画面（web/）
// - POST /bridge/event             … mod からの合図（x-aicarnation-token と x-aicarnation-bridge: 1 が必須）
// - GET  /bridge/stream?token=…    … 画面が購読する SSE
// - GET/POST /bridge/persona       … 選択中のエージェントの人柄（画面が POST、mod が GET）
// - POST /companion/request        … 画面からのモデル依頼。Claude Code の mod に渡し、答えを待つ
// - GET  /companion/requests/next  … mod が依頼を取りに来る（来るまで少し待つ。無ければ 204）
// - POST /companion/answer         … mod からの答え
// - GET  /companion/health         … 起動確認（合言葉不要）
// - GET/POST /companion/engine     … 音声エンジンの起動の様子（mod・MCP が POST、画面が GET。入っていなければ missing）
// - POST /companion/engine/restart … 音声エンジンの再起動を、エンジンを起動した mod（このサーバーの持ち主）に頼む
// - /store/<agents|settings|messages|lines>[/<キー>] … 画面の保存データ（GET/PUT/DELETE、合言葉必須。store.mjs）
// - /files/vrm/<id>                … 読み込んだ VRM（GET/PUT/DELETE、合言葉必須）
// - /tts/aivis/*                   … ローカル音声エンジン（AivisSpeech:10101）への中継（合言葉必須。声のモデルの出し入れ /aivm_models も通す）
//
// 標準出力には mod 向けの JSON を1行ずつ書く：{"kind":"ready",...} / {"kind":"request",...}
import { createServer, request as httpRequest } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { createStore, isKey, isStoreName } from './store.mjs'

const APP = 'aicarnation'
/**
 * サーバーの作りの版。動いているサーバーと版が違えば（同じ画面のフォルダでも）止めて入れ替わる。
 * 合図の扱いを変えたときに上げる（2：どのセッションの合図も画面に送る、3：mod が依頼を取りに来る）
 */
const SERVER_VERSION = 2
const MAX_BODY_BYTES = 64 * 1024
const MAX_STORE_BYTES = 4 * 1024 * 1024
const MAX_VRM_BYTES = 200 * 1024 * 1024
const KEEP_ALIVE_MS = 20_000
const REQUEST_TIMEOUT_MS = 120_000
const MAX_TEXT = 2000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.vrm': 'application/octet-stream',
  '.woff2': 'font/woff2',
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1]
  return out
}

const args = parseArgs(process.argv.slice(2))
const webRoot = resolve(args.web ?? '')
const token = args.token ?? (args['token-file'] ? await loadToken(args['token-file']) : '')
const basePort = Number(args.port ?? 48280)
if (!args.web || !args.data || token.length < 16) {
  console.error('usage: aicarnation-server.mjs --web <dir> --data <dir> (--token <token(16+ chars)> | --token-file <path>) [--port n]')
  process.exit(2)
}

/**
 * 合言葉をファイルから読む。無ければ作って保存する（自分だけが読めるように）。
 * Claude Code（mod）と Claude Desktop（MCP サーバー）のどちらがサーバーを起動しても同じ合言葉になるので、
 * サーバーが入れ替わっても、開いている画面はそのままつながり直せる
 */
async function loadToken(file) {
  try {
    const saved = (await readFile(file, 'utf8')).trim()
    // 自分で作った形（16進の32文字）だけを使う。書き換えられていたら作り直す（URL やコマンドに混ぜても安全なように）
    if (/^[0-9a-f]{32}$/.test(saved)) return saved
  } catch {
    // まだ無い
  }
  const created = randomBytes(16).toString('hex')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, created, { mode: 0o600 })
  return created
}

/** mod 向けの1行 */
function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function send(res, status, body) {
  res.statusCode = status
  if (body === undefined) return res.end()
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

// --- 合図の検証（packages/shared/src/bridge.ts と同じ規則） ---
const NOTICE_KINDS = ['command-failed', 'tests-passed', 'tests-failed']
const str = (v, max = MAX_TEXT) => (typeof v === 'string' && v.length <= max ? v : null)
function parseBridgeEvent(v) {
  if (typeof v !== 'object' || v === null) return null
  if (v.type === 'listening') return str(v.text) === null ? null : { type: 'listening', text: v.text }
  if (v.type === 'working') return str(v.label, 100) === null ? null : { type: 'working', label: v.label }
  if (v.type === 'reply') return str(v.text) === null || !v.text.trim() ? null : { type: 'reply', text: v.text }
  if (v.type === 'idle') return { type: 'idle' }
  if (v.type === 'notice') return NOTICE_KINDS.includes(v.kind) ? { type: 'notice', kind: v.kind } : null
  return null
}
function parsePersona(v) {
  if (typeof v !== 'object' || v === null) return null
  const out = {}
  for (const f of ['name', 'firstPerson', 'tone', 'personality']) {
    if (str(v[f], 500) === null) return null
    out[f] = v[f]
  }
  return out
}

// --- 状態 ---
const store = createStore(resolve(args.data))
const clients = new Set()
let persona = null
/** 画面からのモデル依頼の答え待ち：id → { resolve, timer } */
const pending = new Map()
let nextId = 1

/**
 * モデル依頼の渡し方。Claude Code の mod は、サーバーを起動したかどうかにかかわらず依頼を取りに来る（長く待つ問い合わせ）。
 * Claude Desktop の MCP サーバーが起動したサーバーでも、Claude Code のセッションが1つ動いていれば、そちらが答えられる。
 * 取りに来る mod がいないときだけ、標準出力でサーバーを起動した側（mod か MCP サーバー）に渡す
 */
/** 取りに来て待っている mod：{ res, timer } の並び */
const requestWaiters = []
/** まだ誰も取りに来ていない依頼 */
const requestQueue = []
/** mod が最後に取りに来た時刻（取りに来る mod がいるかの目安） */
let lastRequestPollAt = 0
/** 依頼を取りに来る間隔の目安。これより長く来なければ、取りに来る mod はいないとみなす */
const REQUEST_POLL_STALE_MS = 35_000
/** 1回の取りに来る問い合わせで待つ長さ */
const REQUEST_POLL_WAIT_MS = 20_000
/** 待っている依頼を、取りに来る mod がいなければ標準出力へ回すまでの時間 */
const REQUEST_QUEUE_FALLBACK_MS = 5_000

/**
 * 古い版の mod も扱える依頼。mod は取りに来るときに扱える依頼（ops）を名乗り、名乗らない古い版はこれだけを扱えるとみなす。
 * Claude Code を複数開いていて版が混ざっていても、依頼はそれを扱える mod にだけ渡す
 */
const LEGACY_OPS = new Set(['generate-agent', 'suggest-voice', 'generate-lines'])

/** 取りに来た mod が名乗った、扱える依頼（?ops=a,b） */
function opsOf(url) {
  const given = url.searchParams.get('ops')
  return given ? new Set(given.split(',').filter(Boolean)) : LEGACY_OPS
}

/** 扱える mod がいない依頼を、すぐに断る */
function rejectRequest(request) {
  const waiting = pending.get(request.id)
  if (!waiting) return
  clearTimeout(waiting.timer)
  pending.delete(request.id)
  waiting.resolve({ error: 'この操作に対応した Claude Code が見つかりません。Claude Code を開き直してから、もう一度お試しください' })
}

/**
 * 依頼を mod に渡す。扱える mod が待っていればすぐ、取りに来る mod がいれば次に来たとき、いなければ標準出力で
 * （標準出力の先＝このサーバーを起動した mod は、版が分からないので、古い版でも扱える依頼だけを回す）
 */
function dispatchRequest(request) {
  const i = requestWaiters.findIndex((w) => w.ops.has(request.op))
  if (i >= 0) {
    const [waiter] = requestWaiters.splice(i, 1)
    clearTimeout(waiter.timer)
    send(waiter.res, 200, request)
    return
  }
  const fallback = () => (LEGACY_OPS.has(request.op) ? emit({ kind: 'request', ...request }) : rejectRequest(request))
  if (Date.now() - lastRequestPollAt < REQUEST_POLL_STALE_MS) {
    requestQueue.push(request)
    // 扱える mod がしばらく取りに来なければ、標準出力へ回す（回せない依頼は断る）
    setTimeout(() => {
      const j = requestQueue.indexOf(request)
      if (j < 0) return
      requestQueue.splice(j, 1)
      fallback()
    }, REQUEST_QUEUE_FALLBACK_MS)
    return
  }
  fallback()
}

function broadcast(event) {
  const data = `event: bridge\ndata: ${JSON.stringify(event)}\n\n`
  for (const res of clients) res.write(data)
}

/**
 * 声を出すのは最後に開いた画面だけにする（画面が複数開いていても、同じ返事を二重に読み上げない）。
 * その画面が閉じたら、残りのうち最後に開いたものが引き継ぐ
 */
function announceSpeaker() {
  const list = [...clients]
  list.forEach((res, i) => res.write(`event: role\ndata: ${JSON.stringify({ speaker: i === list.length - 1 })}\n\n`))
}

/** ローカル音声エンジンの待ち受けポート */
const TTS_ENGINES = { aivis: 10101 }

/**
 * 音声エンジンの起動の様子（mod・MCP サーバーが知らせる）。画面はこれを見て、起動を待つか、ブラウザの声にするかを決める。
 * unknown：まだ知らせが無い／starting：起動中／missing：入っていない／stopped：止まった／restarting：再起動を受け付けた
 */
const engineState = { aivis: 'unknown' }
const ENGINE_STATES = new Set(['starting', 'missing', 'stopped', 'restarting'])

/** エンジンの起動を mod に頼んだ時刻。同じエンジンを何度も頼まない */
const engineStartRequestedAt = {}
const ENGINE_START_INTERVAL_MS = 60_000

/** エンジンにつながらないとき、mod に起動を頼む（入っていれば mod が起動する） */
function requestEngineStart(engine) {
  const now = Date.now()
  if (now - (engineStartRequestedAt[engine] ?? 0) < ENGINE_START_INTERVAL_MS) return
  engineStartRequestedAt[engine] = now
  emit({ kind: 'start-engine', engine })
}

/** /tts/<engine>/<path> をエンジンへそのまま中継する（Origin は外す） */
function proxyTts(req, res, engine, rest) {
  const port = TTS_ENGINES[engine]
  const headers = { ...req.headers, host: `127.0.0.1:${port}` }
  delete headers.origin
  delete headers['x-aicarnation-token']
  const upstream = httpRequest({ host: '127.0.0.1', port, method: req.method, path: rest, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers)
    // 返している途中でエンジンが止まった（再起動など）ときは、接続を切るだけにする（サーバーごと落ちないように）
    up.on('error', () => res.destroy())
    up.pipe(res)
  })
  upstream.on('error', () => {
    requestEngineStart(engine)
    if (res.headersSent) {
      res.destroy()
      return
    }
    send(res, 502, { message: `${engine} が起動していません` })
  })
  // 画面側が先に接続を切ったら、エンジンへの問い合わせもやめる
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

/** 合言葉を比べる（かかる時間から推測されないよう、長さをそろえて一定時間で比べる） */
function sameToken(given) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function hasToken(req, url) {
  return sameToken(req.headers['x-aicarnation-token']) || sameToken(url.searchParams.get('token'))
}

/**
 * 起動確認で、合言葉を知っていることを示す（合言葉そのものは出さない）。
 * 問い合わせ側が送った使い捨ての値（nonce）を合言葉で署名して返す。ほかのアプリがポートを先に取っていても、
 * 署名が合わなければ「aicarnation のサーバー」とはみなさない（合言葉を渡したり、プロセスを止めたりしない）
 */
export function healthProof(secret, nonce) {
  return createHmac('sha256', secret).update(`aicarnation-health:${nonce}`).digest('hex')
}

/** このサーバーの待ち受け先として受け付ける Host（DNS リバインディングで、別の名前から届いた問い合わせを断る） */
function allowedHost(host) {
  return host === `127.0.0.1:${basePort}` || host === `localhost:${basePort}`
}

/** 画面の HTML に付ける見出し（読み込める先を自分だけに絞り、ほかのサイトの中に埋め込ませない） */
const PAGE_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self' blob: data:",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

/** web/ の中のファイルだけを返す（フォルダの外は読ませない） */
async function serveStatic(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
  let file = join(webRoot, rel || 'index.html')
  if (!file.startsWith(webRoot + sep) && file !== webRoot) return send(res, 403)
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
    const body = await readFile(file)
    const type = MIME[extname(file)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, ...(extname(file) === '.html' ? PAGE_HEADERS : { 'X-Content-Type-Options': 'nosniff' }) })
    res.end(body)
  } catch {
    // 拡張子の付いたファイル（assets/*.js など）が無ければ 404。画面を更新したあと、古い画面が消えた部品を読みに来たとき、
    // index.html を返すと読み込みの失敗に気づけない（画面は 404 を受けて開き直す）
    if (extname(rel)) return send(res, 404, { message: 'ファイルがありません' })
    // 画面内の遷移先は index.html を返す
    try {
      const body = await readFile(join(webRoot, 'index.html'))
      res.writeHead(200, { 'Content-Type': MIME['.html'], ...PAGE_HEADERS })
      res.end(body)
    } catch {
      send(res, 404, { message: '画面のファイルがありません（web/ をビルドしてください）' })
    }
  }
}

async function handle(req, res) {
  // 127.0.0.1・localhost の名前で届いたものだけを受け付ける（悪意のあるサイトが自分の名前を 127.0.0.1 に向け直して読みに来るのを防ぐ）
  if (!allowedHost(req.headers.host)) return send(res, 421, { message: 'このアドレスからは利用できません' })
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  // 起動確認。nonce を付けて問い合わせると、合言葉で署名した proof を返す（合言葉を知っている本物のサーバーかを見分ける）。
  // プロセス番号は、次に起動したサーバーが古い版のサーバーを止めるのに使い、画面のフォルダは、同じ版のサーバーかどうか（共用してよいか）を見分けるのに使う
  if (path === '/companion/health') {
    const nonce = url.searchParams.get('nonce')
    const proof = nonce && /^[0-9a-f]{16,64}$/.test(nonce) ? healthProof(token, nonce) : undefined
    return send(res, 200, { app: APP, pid: process.pid, web: webRoot, version: SERVER_VERSION, proof })
  }

  // 本物のサーバーだと確かめられた相手（合言葉を知っている）からの、止めてほしいという依頼（新しい版に入れ替えるとき）
  if (path === '/companion/shutdown' && req.method === 'POST') {
    if (!hasToken(req, url)) return send(res, 401, { message: '合言葉が違います' })
    send(res, 204)
    setTimeout(() => process.exit(0), 50)
    return
  }

  const tts = path.match(/^\/tts\/(aivis)(\/.*)?$/)
  if (tts) {
    if (!hasToken(req, url)) return send(res, 401, { message: '合言葉が違います' })
    url.searchParams.delete('token')
    const query = url.searchParams.toString()
    return proxyTts(req, res, tts[1], `${tts[2] ?? '/'}${query ? `?${query}` : ''}`)
  }

  const storePath = path.match(/^\/store\/([a-z]+)(?:\/([^/]+))?$/)
  if (storePath) {
    if (!hasToken(req, url)) return send(res, 401, { message: '合言葉が違います' })
    return handleStore(req, res, url, storePath[1], storePath[2] ? decodeURIComponent(storePath[2]) : null)
  }

  const vrmPath = path.match(/^\/files\/vrm\/([\w-]{1,100})$/)
  if (vrmPath) {
    if (!hasToken(req, url)) return send(res, 401, { message: '合言葉が違います' })
    return handleVrm(req, res, vrmPath[1])
  }

  if (path.startsWith('/bridge/') || path.startsWith('/companion/')) {
    if (!hasToken(req, url)) return send(res, 401, { message: '合言葉が違います' })

    if (path === '/bridge/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      clients.add(res)
      announceSpeaker()
      const timer = setInterval(() => res.write(': keep-alive\n\n'), KEEP_ALIVE_MS)
      req.on('close', () => {
        clearInterval(timer)
        clients.delete(res)
        announceSpeaker()
      })
      return
    }

    if (path === '/bridge/event' && req.method === 'POST') {
      if (req.headers['x-aicarnation-bridge'] !== '1') return send(res, 403, { message: 'x-aicarnation-bridge ヘッダーが必要です' })
      const event = parseBridgeEvent(await readJson(req).catch(() => null))
      if (!event) return send(res, 400, { message: '合図の形が不正です' })
      // 共用しているどのセッション（Claude Code・Claude Desktop のチャット）の合図も、そのまま画面に送る
      broadcast(event)
      return send(res, 200, { delivered: clients.size })
    }

    if (path === '/bridge/persona' && req.method === 'GET') return send(res, 200, persona)
    if (path === '/bridge/persona' && req.method === 'POST') {
      const parsed = parsePersona(await readJson(req).catch(() => null))
      if (!parsed) return send(res, 400, { message: '人柄の形が不正です' })
      persona = parsed
      return send(res, 204)
    }

    if (path === '/bridge/status' && req.method === 'GET') return send(res, 200, { clients: clients.size })

    if (path === '/companion/engine' && req.method === 'GET') return send(res, 200, engineState)
    if (path === '/companion/engine' && req.method === 'POST') {
      const body = await readJson(req).catch(() => null)
      if (!(body?.engine in TTS_ENGINES) || !ENGINE_STATES.has(body?.state)) return send(res, 400, { message: '形が不正です' })
      engineState[body.engine] = body.state
      return send(res, 204)
    }
    // 再起動は、エンジンを起動した持ち主の mod だけができるので、依頼の窓口（どの mod が取るか分からない）ではなく標準出力で頼む
    if (path === '/companion/engine/restart' && req.method === 'POST') {
      const body = await readJson(req).catch(() => null)
      if (!(body?.engine in TTS_ENGINES)) return send(res, 400, { message: '形が不正です' })
      emit({ kind: 'restart-engine', engine: body.engine })
      return send(res, 202, { requested: true })
    }

    // 画面からのモデル依頼：mod に渡して答えを待つ
    if (path === '/companion/request' && req.method === 'POST') {
      const body = await readJson(req).catch(() => null)
      if (typeof body?.op !== 'string') return send(res, 400, { message: '依頼の形が不正です' })
      const id = String(nextId++)
      const answer = await new Promise((resolveAnswer) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolveAnswer({ error: '時間内に答えが返りませんでした' })
        }, REQUEST_TIMEOUT_MS)
        pending.set(id, { resolve: resolveAnswer, timer })
        dispatchRequest({ id, op: body.op, payload: body.payload ?? null })
      })
      return answer.error ? send(res, 502, { message: answer.error }) : send(res, 200, answer.result)
    }

    if (path === '/companion/requests/next' && req.method === 'GET') {
      lastRequestPollAt = Date.now()
      const ops = opsOf(url)
      const q = requestQueue.findIndex((r) => ops.has(r.op))
      if (q >= 0) return send(res, 200, requestQueue.splice(q, 1)[0])
      const waiter = {
        res,
        ops,
        timer: setTimeout(() => {
          const i = requestWaiters.indexOf(waiter)
          if (i >= 0) requestWaiters.splice(i, 1)
          send(res, 204)
        }, REQUEST_POLL_WAIT_MS),
      }
      requestWaiters.push(waiter)
      // 待っている間に mod 側が問い合わせをやめた（接続が切れた）ら、待ちの列から外す
      res.on('close', () => {
        const i = requestWaiters.indexOf(waiter)
        if (i >= 0) {
          requestWaiters.splice(i, 1)
          clearTimeout(waiter.timer)
        }
      })
      return
    }

    if (path === '/companion/answer' && req.method === 'POST') {
      const body = await readJson(req).catch(() => null)
      const waiting = pending.get(String(body?.id))
      if (!waiting) return send(res, 404, { message: '答えを待っている依頼がありません' })
      clearTimeout(waiting.timer)
      pending.delete(String(body.id))
      waiting.resolve(body.error ? { error: String(body.error) } : { result: body.result ?? null })
      return send(res, 204)
    }

    return send(res, 404)
  }

  if (req.method !== 'GET') return send(res, 405)
  return serveStatic(res, path)
}

/** /store/<name>[/<key>]：一覧・1件の取得・保存・削除。?field=&value= 付きの DELETE はまとめて消す */
async function handleStore(req, res, url, name, key) {
  if (!isStoreName(name)) return send(res, 404)
  if (key !== null && !isKey(key)) return send(res, 400, { message: 'キーが不正です' })
  if (key === null) {
    if (req.method === 'GET') return send(res, 200, await store.getAll(name))
    const field = url.searchParams.get('field')
    if (req.method === 'DELETE' && field) {
      await store.deleteWhere(name, field, url.searchParams.get('value'))
      return send(res, 204)
    }
    return send(res, 405)
  }
  if (req.method === 'GET') {
    const value = await store.get(name, key)
    return value === undefined ? send(res, 404) : send(res, 200, value)
  }
  if (req.method === 'PUT') {
    const value = await readJson(req, MAX_STORE_BYTES).catch(() => undefined)
    if (value === undefined) return send(res, 400, { message: '保存する値が不正です' })
    await store.put(name, key, value)
    return send(res, 204)
  }
  if (req.method === 'DELETE') {
    await store.delete(name, key)
    return send(res, 204)
  }
  return send(res, 405)
}

/** /files/vrm/<id>：読み込んだ VRM。ファイル名は x-file-name（URI エンコード）でやり取りする */
async function handleVrm(req, res, id) {
  if (req.method === 'GET') {
    const file = await store.getVrm(id)
    if (!file) return send(res, 404)
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) })
    return res.end(file.data)
  }
  if (req.method === 'PUT') {
    const data = await readBody(req, MAX_VRM_BYTES).catch(() => null)
    if (!data) return send(res, 413, { message: 'ファイルが大きすぎます' })
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? `${id}.vrm`))
    await store.putVrm(id, name.slice(0, 200), data)
    return send(res, 204)
  }
  if (req.method === 'DELETE') {
    await store.deleteVrm(id)
    return send(res, 204)
  }
  return send(res, 405)
}

/**
 * そのポートで動いている aicarnation のサーバーの起動確認の答え（プロセス番号と画面のフォルダ）。ほかのアプリや空きなら null。
 * verified は、同じ合言葉で署名を返した（本物の aicarnation のサーバー）か。署名を返さない古い版は false
 */
async function ourServer(port) {
  try {
    const nonce = randomBytes(16).toString('hex')
    const res = await fetch(`http://127.0.0.1:${port}/companion/health?nonce=${nonce}`, { signal: AbortSignal.timeout(500) })
    const body = await res.json()
    if (body?.app !== APP || !Number.isInteger(body.pid)) return null
    const expected = Buffer.from(healthProof(token, nonce))
    const given = Buffer.from(typeof body.proof === 'string' ? body.proof : '')
    return {
      pid: body.pid,
      web: typeof body.web === 'string' ? body.web : null,
      version: Number(body.version) || 1,
      verified: given.length === expected.length && timingSafeEqual(given, expected),
    }
  } catch {
    return null
  }
}

/**
 * 古い aicarnation のサーバーを止める。署名で本物と確かめられれば、合言葉付きで止めてもらう。
 * 署名を返さない古い版（版 1）だけは、名乗ったプロセス番号で止める（入れ替えのため）
 */
async function stopServer(found) {
  if (found.pid === process.pid) return
  if (found.verified) {
    await fetch(`http://127.0.0.1:${basePort}/companion/shutdown`, {
      method: 'POST',
      headers: { 'x-aicarnation-token': token },
      signal: AbortSignal.timeout(1000),
    }).catch(() => undefined)
    return
  }
  if (found.version >= 2) return
  try {
    process.kill(found.pid)
  } catch {
    // もう止まっている
  }
}

/** そのポートで動いている aicarnation のサーバーのプロセス番号。ほかのアプリや空きなら null */
async function ourServerPid(port) {
  return (await ourServer(port))?.pid ?? null
}

/**
 * 版の違う aicarnation のサーバーが残っていれば止める。
 * 止めるのは起動確認で aicarnation と名乗ったプロセスだけで、ほかのアプリには触らない
 */
async function stopOldServers() {
  const found = await ourServer(basePort)
  if (found) await stopServer(found)
}

/** ポートは basePort（既定 48280）だけを使う（/aicarnation で開く URL を変えないため） */
const LISTEN_RETRIES = 20
const LISTEN_WAIT_MS = 250

function listen(retriesLeft) {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500))
  })
  server.once('error', async (err) => {
    if (err.code !== 'EADDRINUSE') {
      emit({ kind: 'error', message: err.message })
      process.exit(1)
    }
    // 古い aicarnation が残っていれば止めて取り直す。止めたあとポートが空くまで少し待つ
    const found = await ourServer(basePort)
    if (found) await stopServer(found)
    if (retriesLeft > 0 && (found !== null || (await portNotAnswering()))) {
      setTimeout(() => listen(retriesLeft - 1), LISTEN_WAIT_MS)
      return
    }
    emit({ kind: 'error', message: `ポート ${basePort} を別のアプリが使っています` })
    process.exit(1)
  })
  server.listen(basePort, '127.0.0.1', () => {
    emit({ kind: 'ready', port: basePort, token, url: `http://127.0.0.1:${basePort}/?token=${token}` })
  })
}

/** 止めた直後はまだポートが閉じきっていないことがあるので、応答が無い（閉じかけの）うちは待つ */
async function portNotAnswering() {
  return (await ourServerPid(basePort)) === null
}

// 同じ版のサーバーがもう動いていれば（ほかのセッションや Claude Desktop が起動したもの）、それを共用する。
// 止めて入れ替えると、起動したセッションが終わったときにサーバーが無くなってしまうため。
// 古い版（画面のフォルダか、サーバーの作りの版が違う）のサーバーだけ止める
const running = await ourServer(basePort)
// 共用するのは、同じ合言葉で署名を返した本物のサーバーだけ（ほかのアプリがポートを取っていても、合言葉を渡さない）
if (running && running.verified && running.web === webRoot && running.version === SERVER_VERSION) {
  emit({ kind: 'shared', port: basePort, token, url: `http://127.0.0.1:${basePort}/?token=${token}` })
  // 知らせを書き終えてから終わる（すぐ終えると、パイプに書き切れないことがある）
  setTimeout(() => process.exit(0), 100)
} else {
  await stopOldServers()
  listen(LISTEN_RETRIES)
}

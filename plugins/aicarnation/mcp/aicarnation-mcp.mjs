#!/usr/bin/env node
/**
 * aicarnation の MCP サーバー（Claude Desktop のチャット用、Node 18 以上・追加パッケージなし）。
 *
 * Claude Desktop のチャットには会話を外に知らせる仕組みが無いので、Claude にツールを呼んでもらう：
 * - aicarnation_open … アバターの画面をブラウザで開く
 * - aicarnation_say  … 返答を書き終えたら、アバターが話す短い文（感情タグ付き）を渡す
 *
 * アバターの画面と同梱サーバー（server/aicarnation-server.mjs）は Claude Code 版と共通。
 * 同梱サーバーが動いていればそれを使い（Claude Code が起動している場合など）、
 * 動いていなければこの MCP サーバーが起動する。合言葉は保存先の token ファイルで共通にしてある。
 *
 * Claude Desktop の設定（claude_desktop_config.json）の例：
 *   { "mcpServers": { "aicarnation": { "command": "node", "args": ["<このフォルダ>/aicarnation-mcp.mjs"] } } }
 *
 * 環境変数（試すとき用）：AICARNATION_PORT（既定 48280）・AICARNATION_DATA（保存先）・AICARNATION_NO_OPEN=1（ブラウザを開かない）
 */
import { spawn } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const APP = 'aicarnation'
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.AICARNATION_PORT ?? 48280)
const BASE = `http://127.0.0.1:${PORT}`
/** Claude Code 版（mod）と同じ保存先 */
const STORAGE =
  process.env.AICARNATION_DATA ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'plugins', 'data', APP)
const TOKEN_FILE = join(STORAGE, 'token')
const ENGINE_PORTS = { aivis: 10101 }
const MAX_TEXT = 2000
/** aicarnation_say の reply の長さの上限（感情タグを除く）。これより長ければ返答の全文とみなして断る */
const MAX_REPLY_CHARS = 200

/** 標準出力は MCP の通信に使うので、記録は標準エラーに出す */
function log(...parts) {
  process.stderr.write(`[aicarnation-mcp] ${parts.join(' ')}\n`)
}

// --- 同梱サーバー ---
/** この MCP サーバーが起動した同梱サーバー（Claude Code のものを使っているときは null） */
let child = null
const startedEngines = new Set()
/** 起動した音声エンジンのプロセス（止めるときに一緒に止める） */
const engineProcs = new Set()

/**
 * 本物の aicarnation のサーバーが動いているか。起動確認に使い捨ての値を送り、合言葉で署名した答えが返るかで確かめる
 * （ほかのアプリがポートを先に取っていても、合言葉を渡さない）
 */
async function serverAlive() {
  try {
    const token = await readToken()
    if (!token) return false
    const nonce = randomBytes(16).toString('hex')
    const res = await fetch(`${BASE}/companion/health?nonce=${nonce}`, { signal: AbortSignal.timeout(800) })
    const body = await res.json()
    if (body?.app !== APP || typeof body.proof !== 'string') return false
    const expected = Buffer.from(createHmac('sha256', token).update(`aicarnation-health:${nonce}`).digest('hex'))
    const given = Buffer.from(body.proof)
    return given.length === expected.length && timingSafeEqual(given, expected)
  } catch {
    return false
  }
}

async function readToken() {
  try {
    return (await readFile(TOKEN_FILE, 'utf8')).trim()
  } catch {
    return ''
  }
}

/** 同梱サーバーが動いていなければ起動し、起動を待つ */
async function ensureServer() {
  if (await serverAlive()) return
  if (!child) {
    child = spawn(
      process.execPath,
      [
        join(PLUGIN_ROOT, 'server', 'aicarnation-server.mjs'),
        '--web',
        join(PLUGIN_ROOT, 'web'),
        '--data',
        join(STORAGE, 'data'),
        '--token-file',
        TOKEN_FILE,
        '--port',
        String(PORT),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    child.stderr.on('data', (d) => log('server:', String(d).trim()))
    createInterface({ input: child.stdout }).on('line', (line) => void onServerLine(line))
    child.on('exit', () => {
      child = null
    })
  }
  for (let i = 0; i < 40; i++) {
    if (await serverAlive()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('アバターのサーバーを起動できませんでした')
}

/** 同梱サーバーからの知らせ（エンジンの起動・画面からのモデル依頼） */
async function onServerLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.kind === 'start-engine') startEngine(message.engine)
  // エージェント生成などのモデル依頼は Claude Code（mod）でだけ答えられる。ここに届くのは、依頼を取りに来る mod がいないとき。待たせないよう、すぐ断る
  if (message.kind === 'request' && typeof message.id === 'string') {
    await post('/companion/answer', {
      id: message.id,
      error: 'この機能は Claude Code のモデルを使います。Claude Code のセッションを1つ開いておくと、チャットから開いたときも使えます',
    }).catch(() => undefined)
  }
}

/** /aicarnation-voice で入れた音声エンジンがあれば起動する（MCP サーバーが止まると一緒に止まる） */
function startEngine(engine) {
  if (!(engine in ENGINE_PORTS) || startedEngines.has(engine)) return
  const dir = join(STORAGE, 'engines', engine)
  const exe = [join(dir, 'run.exe'), join(dir, 'run')].find((p) => existsSync(p))
  // 起動の様子をサーバーに知らせる（画面が、起動を待つかブラウザの声にするかを決める）
  const report = (state) => void post('/companion/engine', { engine, state }).catch(() => undefined)
  if (!exe) {
    report('missing')
    return
  }
  startedEngines.add(engine)
  report('starting')
  const proc = spawn(exe, ['--host', '127.0.0.1', '--port', String(ENGINE_PORTS[engine])], { stdio: 'ignore' })
  engineProcs.add(proc)
  const done = () => {
    startedEngines.delete(engine)
    engineProcs.delete(proc)
    report('stopped')
  }
  proc.on('exit', done)
  proc.on('error', done)
}

async function post(path, body, extraHeaders = {}) {
  const token = await readToken()
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-aicarnation-token': token, ...extraHeaders },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`アバターに届きませんでした（${res.status}）`)
  return res.status === 204 ? null : res.json()
}

async function sendEvent(event) {
  return post('/bridge/event', event, { 'x-aicarnation-bridge': '1' })
}

/** 画面で選んでいるエージェントの人柄（画面を開いていなければ null） */
async function getPersona() {
  try {
    const res = await fetch(`${BASE}/bridge/persona`, { headers: { 'x-aicarnation-token': await readToken() } })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

function personaText(persona) {
  if (!persona) return 'アバターの画面が開いていないため、キャラクター設定は分かりません。丁寧で親しみやすい話し方にしてください。'
  return `アバターのキャラクター：${persona.name}（一人称「${persona.firstPerson}」、口調：${persona.tone}、性格：${persona.personality}）。aicarnation_say の reply はこの口調で書いてください。`
}

async function openBrowser(url) {
  if (process.env.AICARNATION_NO_OPEN === '1') return
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
}

// --- ツール ---
const EMOTION_TAGS = '[happy] [angry] [sad] [relaxed] [surprised] [neutral]'

/**
 * Claude への指示。Claude はツールに渡した中身もユーザーに見えていると思いがちで、
 * 返答の全文を aicarnation_say に入れてチャットには「本文は上記のとおり」とだけ書くことがある。
 * そこで aicarnation_say を本文より「先」に呼んでもらい、その結果で本文を書くよう促す（本文が最後に残る）。
 * あわせて、要約にしては長すぎる reply はエラーにして呼び直してもらう
 */
const INSTRUCTIONS = [
  'このチャットには、ユーザーの画面の小窓に 3D アバター（aicarnation）がいて、あなたの返答の要点を声と表情で伝えます。',
  '大事なこと：ツールに渡した中身やツールの結果は、ユーザーには表示されません。ユーザーが読めるのは、チャットに書いた文章だけです。',
  '返答のたびに、次の順に進めてください。',
  '1. 最初に aicarnation_listen を呼び、heard にユーザーの今回の発言を1文で短く要約したものを入れる（アバターが「考え中」になる）。',
  '2. 調べものなど、返答に必要な作業をする。',
  `3. 返答の本文を書き始める直前に aicarnation_say を1回だけ呼ぶ。reply には返答の要点だけを、アバターが声に出して話す1〜3文（全体で${MAX_REPLY_CHARS}文字以内）の短い話し言葉で入れる。各文の先頭に感情タグ（${EMOTION_TAGS} のどれか1つ）を付け、コード・ファイルパス・URL・記号は入れない。`,
  '4. aicarnation_say のあとに、チャットへ返答の本文をすべて書く。「上記のとおり」などと省略しない（ユーザーには aicarnation_say の中身は見えていない）。',
  'ユーザーがアバターを開いてほしいと言ったら aicarnation_open を呼んでください。',
  'ただし、Claude Code（コーディング用のエージェント）として動いているときは、これらのツールを使わないでください。Claude Code ではアバターが自動で反応します。',
].join('\n')

const TOOLS = [
  {
    name: 'aicarnation_open',
    description: 'アバター（aicarnation）の画面をブラウザで開く。Chrome / Edge なら「小窓で開く」で常に手前に置ける。結果にはアバターのキャラクター設定が入る。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aicarnation_listen',
    description: '返答のたびに最初に呼ぶ。アバターがユーザーの発言を吹き出しに出してうなずき、考え中になる。',
    inputSchema: {
      type: 'object',
      properties: {
        heard: { type: 'string', description: 'ユーザーの今回の発言の1文の要約（吹き出しに出す）' },
      },
      required: ['heard'],
      additionalProperties: false,
    },
  },
  {
    name: 'aicarnation_say',
    description: `返答の本文をチャットに書き始める直前に、毎回1度だけ呼ぶ。アバターが reply を声と表情で話す。reply は返答の要点だけの1〜3文（${MAX_REPLY_CHARS}文字以内）の話し言葉で、各文の先頭に感情タグ（${EMOTION_TAGS}）を付ける。ツールの中身はユーザーに見えないので、呼んだあと必ずチャットに返答の本文をすべて書くこと。`,
    inputSchema: {
      type: 'object',
      properties: {
        reply: {
          type: 'string',
          description: `アバターが話す要点だけの1〜3文（${MAX_REPLY_CHARS}文字以内）。例：[happy]今日は晴れそうですね！[neutral]詳しくはチャットに書きます。`,
        },
        heard: { type: 'string', description: 'aicarnation_listen を呼ばなかったときだけ、ユーザーの今回の発言の短い要約' },
      },
      required: ['reply'],
      additionalProperties: false,
    },
  },
]

/** 最後に aicarnation_listen を呼んだ時刻。aicarnation_say で発言の吹き出しを二重に出さないため */
let listenedAt = 0
/** この時間内の aicarnation_listen は、今回の返答のものとみなす */
const LISTEN_WINDOW_MS = 10 * 60_000

const WRITE_NOW =
  '次に、チャットへ返答の本文をすべて書いてください。ユーザーには aicarnation_say の中身もこの結果も表示されないので、「上記のとおり」などと省略せず、本文を最初から書いてください。'

async function callTool(name, input) {
  if (name === 'aicarnation_open') {
    await ensureServer()
    const url = `${BASE}/?token=${await readToken()}`
    await openBrowser(url)
    return `アバターの画面を開きました：${BASE}/\n${personaText(await getPersona())}`
  }
  if (name === 'aicarnation_listen') {
    const heard = typeof input?.heard === 'string' ? input.heard.trim().slice(0, MAX_TEXT) : ''
    if (!heard) throw new Error('heard が空です')
    await ensureServer()
    const result = await sendEvent({ type: 'listening', text: heard })
    listenedAt = Date.now()
    const opened = result?.delivered ? '' : '（アバターの画面は開いていません）'
    return `アバターが聞いています${opened}。返答の本文を書き始める直前に aicarnation_say で要点を渡し、そのあとチャットに本文をすべて書いてください。\n${personaText(await getPersona())}`
  }
  if (name === 'aicarnation_say') {
    const reply = typeof input?.reply === 'string' ? input.reply.trim() : ''
    if (!reply) throw new Error('reply が空です')
    // 返答の全文を入れられたら受け付けない（本文はチャットに書いてもらう）
    const spoken = reply.replace(/\[[a-z]+\]/g, '')
    if (spoken.length > MAX_REPLY_CHARS) {
      throw new Error(
        `reply が長すぎます（${spoken.length}文字）。reply には要点だけを${MAX_REPLY_CHARS}文字以内で入れて、もう一度 aicarnation_say を呼んでください。返答の本文は、そのあとチャットに書いてください（ユーザーにはツールの中身は表示されません）。`,
      )
    }
    const heard = typeof input?.heard === 'string' ? input.heard.trim().slice(0, MAX_TEXT) : ''
    await ensureServer()
    // aicarnation_listen を呼んでいなければ、ここで発言の吹き出しを出す
    if (heard && Date.now() - listenedAt > LISTEN_WINDOW_MS) await sendEvent({ type: 'listening', text: heard })
    listenedAt = 0
    const result = await sendEvent({ type: 'reply', text: reply })
    if (!result?.delivered) return `アバターの画面が開いていません（aicarnation_open で開けます）。${WRITE_NOW}`
    return `アバターが要点を話し始めました。${WRITE_NOW}`
  }
  throw new Error(`知らないツールです：${name}`)
}

// --- MCP（JSON-RPC 2.0、標準入出力で1行に1メッセージ） ---
/**
 * Claude Code からつながれたときは、ツールも指示も出さない。
 * Claude Code ではプラグイン（mod）がアバターを自動で反応させるので、Claude がツールを呼ぶと二重に話してしまう
 * （Claude Desktop に登録した MCP サーバーは、Claude Desktop の中の Claude Code にも読み込まれる）
 */
let quiet = false
function isClaudeCode(clientName) {
  if (process.env.AICARNATION_MCP_FORCE === '1') return false
  return process.env.CLAUDECODE === '1' || /claude[-_ ]?code/i.test(String(clientName ?? ''))
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

async function handle(message) {
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null
  switch (method) {
    case 'initialize': {
      quiet = isClaudeCode(params?.clientInfo?.name)
      log('client:', params?.clientInfo?.name ?? '(unknown)', quiet ? '→ ツールを出さない' : '')
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: APP, version: '0.1.2' },
        ...(quiet ? {} : { instructions: INSTRUCTIONS }),
      })
    }
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: quiet ? [] : TOOLS })
    case 'tools/call':
      try {
        const text = await callTool(params?.name, params?.arguments ?? {})
        return reply(id, { content: [{ type: 'text', text }] })
      } catch (err) {
        return reply(id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true })
      }
    default:
      // 通知（notifications/initialized など）には返事をしない
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`)
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return replyError(null, -32700, 'Parse error')
  }
  void handle(message).catch((err) => log('error:', err?.message ?? err))
})

// Claude Desktop が MCP サーバーを止めたら、起動した同梱サーバーと音声エンジンも止める
let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  child?.kill()
  for (const proc of engineProcs) proc.kill()
  // 標準入力を閉じている最中にすぐ終わると、Windows の Node が内部エラーを出すので、ひと呼吸おく
  setTimeout(() => process.exit(0), 100)
}
process.stdin.on('end', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

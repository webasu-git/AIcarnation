import type { EngineInterface, Register } from 'claude-code'

/**
 * aicarnation：Claude Code で話している間、横の小窓の 3D アバターが反応するプラグイン。
 *
 * - セッション開始時に同梱サーバー（server/aicarnation-server.mjs）を起動する。セッションが終わると止まる
 * - /aicarnation でブラウザにアバターの画面（web/）を開く
 * - 話しかけ・ツール使用・返答をアバターに送る。返答は haiku で1〜3文の話し言葉に要約する
 * - 画面からのモデル依頼（エージェント生成・声の推薦）に Claude Code のモデルで答える（API キー不要）
 */
const DEFAULT_PORT = 48280
const MAX_ANSWER_CHARS = 8000
const MAX_PROMPT_CHARS = 300

/** apps/web と packages/shared の EMOTION_TAG_INSTRUCTION と同じ内容（mod はアプリのコードを読み込めないため写している） */
const EMOTION_TAG_INSTRUCTION = [
  '応答の各文の先頭に、その文の感情を表すタグを1つだけ付けてください。',
  '使えるタグは [happy] [angry] [sad] [relaxed] [surprised] [neutral] のみです。',
  '例：[happy]それはいいですね！[neutral]詳しく教えてください。',
].join('\n')

const TOOL_LABELS: Record<string, string> = {
  Read: 'ファイルを読んでいます',
  Edit: 'ファイルを書き換えています',
  Write: 'ファイルを書いています',
  NotebookEdit: 'ノートブックを書き換えています',
  Bash: 'コマンドを実行しています',
  PowerShell: 'コマンドを実行しています',
  Grep: '探しています',
  Glob: '探しています',
  WebFetch: '調べています',
  WebSearch: '調べています',
  Agent: '手分けして作業しています',
}

/** 中身ごと消す、Claude Code が足す内部メモのタグ */
const HIDDEN_BLOCKS = ['system-reminder', 'local-command-caveat', 'local-command-stdout', 'command-name', 'command-message', 'command-args']

/**
 * 入力を吹き出しに出せる自然な文章だけにする（packages/shared の cleanPromptText と同じ処理）。
 * 内部メモは中身ごと消し、貼り付けの囲みなどのタグは外して中の文章を残す
 */
function cleanPromptText(text: string): string {
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

interface Persona {
  name: string
  firstPerson: string
  tone: string
  personality: string
}

/** packages/shared の NoticeKind と同じ */
type NoticeKind = 'command-failed' | 'tests-passed' | 'tests-failed'

type BridgeEvent =
  | { type: 'listening'; text: string }
  | { type: 'working'; label: string }
  | { type: 'reply'; text: string }
  | { type: 'idle' }
  | { type: 'notice'; kind: NoticeKind }

/** アバターの MCP サーバー（mcp/aicarnation-mcp.mjs）のツール。登録名が何でも `mcp__<名前>__aicarnation_say` などになる */
const AICARNATION_MCP_TOOL = /^mcp__.+__aicarnation_(listen|say|open)$/

/** テストを走らせるコマンドか（よく使うテストランナーの名前で見分ける） */
const TEST_COMMAND = /\b(vitest|jest|mocha|pytest|rspec|phpunit|go test|cargo test|dotnet test|(npm|pnpm|yarn|bun)( run)? test)\b/

/** コマンドの結果から、アバターに知らせる出来事を決める。知らせるほどでなければ null */
function noticeFor(command: string, failed: boolean): NoticeKind | null {
  if (TEST_COMMAND.test(command)) return failed ? 'tests-failed' : 'tests-passed'
  return failed ? 'command-failed' : null
}

interface VoiceOption {
  voiceURI: string
  name: string
  lang: string
}

// --- 状態（mod の再読み込みで初期化される） ---
/** 同梱サーバーの URL（http://127.0.0.1:<port>）。起動前・停止後は null */
let baseUrl: string | null = null
/** 同梱サーバーの合言葉。保存先の token ファイルにあり、サーバーが起動したときに知らせてくる */
let token = ''
/** 直前の合図を受け取った画面の数。0 ならアバターは開いていない */
let listeners = 0
/** 直前に送った作業の様子。同じものを何度も送らない */
let lastLabel = ''
/** サーバーが起動できなかった理由。止まったあともステータス行に残す */
let serverError: string | null = null
/** このセッションが起動したサーバーのプロセスが動いている（起動中も含む）か */
let serverRunning = false
/** ほかのセッション（Claude Desktop も含む）が起動したサーバーを共用しているか */
let sharedServer = false

function pageUrl(): string | null {
  return baseUrl ? `${baseUrl}/?token=${token}` : null
}

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-aicarnation-token': token }
}

/**
 * Node の実行ファイル。mac で Claude のアプリから起動すると、Homebrew などの場所が PATH に入っていないことがあるので、
 * よくある場所も探す。環境変数 AICARNATION_NODE で指定もできる
 */
async function nodeCommand($: EngineInterface): Promise<string> {
  const given = await $.env.get('AICARNATION_NODE')
  if (given) return given
  if ((await $.env.get('OS')) === 'Windows_NT') {
    // 名前だけだと、Windows ではいまのフォルダ（利用者のプロジェクト）の node.exe が先に見つかることがあるので、
    // 公式のインストーラーが入れる場所を先に探す
    const programFiles = (await $.env.get('ProgramFiles')) ?? 'C:\\Program Files'
    const official = `${programFiles}\\nodejs\\node.exe`
    if (await $.fs.exists(official).catch(() => false)) return official
    return 'node'
  }
  for (const path of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (await $.fs.exists(path).catch(() => false)) return path
  }
  return 'node'
}

/** 同梱サーバーを起動し、標準出力の知らせ（起動・画面からの依頼）を読み続ける */
async function runServer($: EngineInterface): Promise<void> {
  if (serverRunning) return
  serverRunning = true
  sharedServer = false
  serverError = null
  const root = $.plugin.root
  const child = $.process.spawn({
    argv: [await nodeCommand($), `${root}/server/aicarnation-server.mjs`, '--web', `${root}/web`, '--data', dataDir($), '--token-file', tokenFile($), '--port', String(DEFAULT_PORT)],
  })
  let buffer = ''
  try {
    for await (const piece of child) {
      if (piece.stream !== 'stdout') continue
      buffer += piece.text
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) await onServerMessage($, line)
      }
    }
    // 共用しているときは、サーバーのプロセスはすぐ終わる（動いているのはほかのセッションのサーバー）
    if (sharedServer) {
      serverRunning = false
      return
    }
    $.ui.status(serverError ?? 'アバター：サーバーが止まりました')
  } catch {
    $.ui.status('アバター：サーバーを起動できません（Node 18 以上が必要です）')
  }
  serverRunning = false
  baseUrl = null
  listeners = 0
}

/** サーバーが答えるか */
async function serverAnswers($: EngineInterface): Promise<boolean> {
  if (!baseUrl) return false
  try {
    return (await $.http.fetch(`${baseUrl}/companion/health`)).ok
  } catch {
    return false
  }
}

/**
 * サーバーが使えるようにして、使えるようになるまで待つ。
 * 共用していたサーバー（ほかのセッションや Claude Desktop が起動したもの）が止まっていたら、このセッションで起動し直す
 */
async function ensureServer($: EngineInterface, waitMs = 8000): Promise<boolean> {
  if (await serverAnswers($)) return true
  baseUrl = null
  if (!storageRoot) storageRoot = await resolveStorageRoot($)
  void runServer($)
  for (let waited = 0; waited < waitMs && !baseUrl; waited += 250) await $.clock.sleep(250)
  return baseUrl !== null
}


async function onServerMessage($: EngineInterface, line: string): Promise<void> {
  let message: { kind?: string; port?: number; token?: string; id?: string; op?: string; payload?: unknown }
  try {
    message = JSON.parse(line) as typeof message
  } catch {
    return
  }
  if ((message.kind === 'ready' || message.kind === 'shared') && typeof message.port === 'number') {
    baseUrl = `http://127.0.0.1:${message.port}`
    token = message.token ?? ''
    sharedServer = message.kind === 'shared'
    $.ui.status('アバター：/aicarnation で開けます')
    return
  }
  if (message.kind === 'error') {
    serverError = `アバター：起動できません（${String((message as { message?: unknown }).message ?? '')}）`
    $.ui.status(serverError)
    return
  }
  if (message.kind === 'request' && typeof message.id === 'string') {
    void answerRequest($, message.id, message.op ?? '', message.payload)
    return
  }
  if (message.kind === 'start-engine') {
    const engine = (message as { engine?: unknown }).engine
    if (engine === 'aivis') void startEngine($, engine)
  }
  if (message.kind === 'restart-engine') {
    const engine = (message as { engine?: unknown }).engine
    if (engine === 'aivis') void restartEngine($, engine)
  }
}

// --- ローカル音声エンジンの自動起動（AivisSpeech だけ。声は利用者が .aivmx で入れる） ---
const ENGINE_PORTS = { aivis: 10101 } as const
const ENGINE_LABELS = { aivis: 'AivisSpeech' } as const
type EngineId = keyof typeof ENGINE_PORTS
/** このセッションで起動したエンジン（同じエンジンを二重に起動しない） */
const startedEngines = new Set<EngineId>()
/** 起動中のエンジンを止める手段と、止まったら済む約束（画面の「再起動」で使う） */
const engineRuns = new Map<EngineId, { stop: () => void; done: Promise<void> }>()

/**
 * プラグインが使うものは、すべて1つの保存先フォルダに置く（フォルダごと消せば跡が残らない）。
 * - data/    … 画面の保存データ（エージェント・設定・履歴・読み込んだ VRM）
 * - engines/ … /aicarnation-voice で入れた音声エンジン
 *
 * プラグインのフォルダ（$.plugin.root）は更新のたびに版ごとの場所へ入れ替わるので、保存先にしない。
 * Claude Code がプラグインに用意する保存先（CLAUDE_PLUGIN_DATA、更新しても残る）が渡されていればそれを、
 * 無ければ同じ慣例の ~/.claude/plugins/data/aicarnation を使う
 */
let storageRoot = ''

async function resolveStorageRoot($: EngineInterface): Promise<string> {
  const given = await $.env.get('CLAUDE_PLUGIN_DATA')
  if (given) return given
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const claudeDir = configDir ?? (home ? `${home}/.claude` : null)
  // ホームが分からないときだけ、プラグインのフォルダの中に置く
  return claudeDir ? `${claudeDir}/plugins/data/${$.plugin.name}` : `${$.plugin.root}/.data`
}

/** 保存先を決めてから同梱サーバーを起動する（セッション開始を待たせないよう裏で行う） */
async function startCompanion($: EngineInterface): Promise<void> {
  storageRoot = await resolveStorageRoot($)
  await writeDesktopLauncher($).catch(() => undefined)
  await runServer($)
}

/** Claude Desktop に登録する MCP サーバーの入口（保存先フォルダに置く。版が変わっても同じ場所） */
function desktopLauncherPath(): string {
  return `${storageRoot}/claude-desktop-mcp.mjs`
}

/**
 * Claude Desktop のチャット用 MCP サーバーの入口を、保存先フォルダに作り直す。
 * プラグインの置き場所（$.plugin.root）は更新のたびに変わるので、Claude Desktop にはこの入口を登録してもらい、
 * 入口が「いまのプラグイン」の MCP サーバーを読み込む。保存先も同じフォルダを使うので、合言葉がずれない
 */
async function writeDesktopLauncher($: EngineInterface): Promise<void> {
  if (!storageRoot) return
  await $.fs.write(`${storageRoot}/plugin-root.json`, JSON.stringify({ root: $.plugin.root }))
  await $.fs.write(desktopLauncherPath(), DESKTOP_LAUNCHER)
}

const DESKTOP_LAUNCHER = String.raw`// AIcarnation：Claude Desktop のチャット用 MCP サーバーの入口。Claude Code のプラグインが、セッションのたびに作り直します。
// プラグインの置き場所は版ごとに変わるので、ここから「いまのプラグイン」の MCP サーバーを読み込みます（このファイルは編集しないでください）
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 保存先（合言葉・キャラクターなど）は、このファイルのあるフォルダ。Claude Code のプラグインと同じ場所を使う
process.env.AICARNATION_DATA ??= here
const { root } = JSON.parse(readFileSync(join(here, 'plugin-root.json'), 'utf8'))
await import(pathToFileURL(join(root, 'mcp', 'aicarnation-mcp.mjs')).href)
`

/** Claude Desktop の設定ファイルに書く、アバターの MCP サーバーの項目 */
interface DesktopEntry {
  command: string
  args: string[]
}

/** /aicarnation-desktop で見せた登録の内容。yes はこれと同じものだけを書く（見せる前の yes は受け付けない） */
let shownDesktopEntry = ''

/**
 * Claude Desktop の設定ファイル（claude_desktop_config.json）の場所。設定のフォルダが無ければ null（Claude Desktop が無い）。
 * Windows の Microsoft Store 版は、%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude に置かれる
 */
async function desktopConfigPath($: EngineInterface): Promise<string | null> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const exists = (path: string) => $.fs.exists(path).catch(() => false)
  if (isWindows) {
    const appData = await $.env.get('APPDATA')
    if (appData && (await exists(`${appData}\\Claude`))) return `${appData}\\Claude\\claude_desktop_config.json`
    const local = await $.env.get('LOCALAPPDATA')
    if (local) {
      const packages = await $.fs.list(`${local}\\Packages`).catch(() => [])
      const store = packages.find((e) => e.kind === 'dir' && e.name.startsWith('Claude_'))
      if (store) {
        const dir = `${local}\\Packages\\${store.name}\\LocalCache\\Roaming\\Claude`
        if (await exists(dir)) return `${dir}\\claude_desktop_config.json`
      }
    }
    return null
  }
  const home = await $.env.get('HOME')
  if (!home) return null
  const dir = `${home}/Library/Application Support/Claude`
  return (await exists(dir)) ? `${dir}/claude_desktop_config.json` : null
}

/** 設定ファイルを読む。無ければ空の設定、JSON として読めなければ null（書き換えない） */
async function readDesktopConfig($: EngineInterface, path: string): Promise<{ config: Record<string, unknown>; text: string | null } | null> {
  if (!(await $.fs.exists(path).catch(() => false))) return { config: {}, text: null }
  const text = await $.fs.read(path)
  if (!text.trim()) return { config: {}, text }
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { config: parsed as Record<string, unknown>, text } : null
  } catch {
    return null
  }
}

/**
 * /aicarnation-desktop：Claude Desktop のチャットでもアバターが反応するよう、Claude Desktop の設定ファイルに
 * アバターの MCP サーバーを登録する。1回目は書く内容を見せるだけで、`/aicarnation-desktop yes` で書く。
 * 書くときは元の設定ファイルを控えに残し、ほかの項目には触らず、mcpServers.aicarnation だけを足す（あれば入れ替える）
 */
async function desktopCommand($: EngineInterface, args: string): Promise<string> {
  if (!storageRoot) storageRoot = await resolveStorageRoot($)
  await writeDesktopLauncher($)
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const node = await nodeCommand($)
  const toNative = (p: string) => (isWindows ? p.replaceAll('/', '\\') : p)
  const entry: DesktopEntry = { command: toNative(node), args: [toNative(desktopLauncherPath())] }
  const entryJson = JSON.stringify({ mcpServers: { aicarnation: entry } }, null, 2)
  const nodeNote =
    node === 'node'
      ? ['', '※ Claude Desktop が node を見つけられない場合は、"command" を node の場所（例：/usr/local/bin/node）に変えてください。']
      : []

  const path = await desktopConfigPath($)
  if (!path) {
    return [
      'Claude Desktop の設定のフォルダが見つかりませんでした（Claude Desktop が入っていないか、まだ一度も起動していません）。',
      'Claude Desktop を入れて一度起動してから、もう一度このコマンドを実行してください。',
      '',
      'ご自分で書く場合は、Claude Desktop の設定ファイル（claude_desktop_config.json）に次の内容を書いてください。',
      '',
      entryJson,
      ...nodeNote,
    ].join('\n')
  }
  const read = await readDesktopConfig($, path)
  if (!read) {
    return `Claude Desktop の設定ファイルを JSON として読めなかったため、書き換えませんでした。\n設定ファイル：${path}\n内容を直してから、もう一度実行してください。`
  }
  const servers = (read.config.mcpServers && typeof read.config.mcpServers === 'object' ? read.config.mcpServers : {}) as Record<string, unknown>
  const current = servers.aicarnation
  if (JSON.stringify(current) === JSON.stringify(entry)) {
    return `Claude Desktop には、すでにアバターの MCP サーバーが登録されています（設定ファイル：${path}）。\nチャットでアバターが反応しない場合は、Claude Desktop を開き直してください。`
  }

  const confirmed = args.trim().toLowerCase() === 'yes' && shownDesktopEntry === JSON.stringify(entry)
  if (!confirmed) {
    shownDesktopEntry = JSON.stringify(entry)
    return [
      'Claude Desktop のチャットでもアバターが反応するよう、Claude Desktop の設定ファイルにアバターの MCP サーバーを登録します。',
      '',
      `設定ファイル：${path}`,
      current
        ? '・いま登録されている "aicarnation" の項目を、次の内容に入れ替えます。'
        : read.text === null
          ? '・設定ファイルが無いので、新しく作ります。'
          : '・"mcpServers" に "aicarnation" の項目を足します。ほかの設定には触りません。',
      read.text === null ? '' : '・書き換える前の設定ファイルを、同じフォルダに控えとして残します。',
      '',
      entryJson,
      ...nodeNote,
      '',
      'よろしければ、次のコマンドで登録してください。',
      '/aicarnation-desktop yes',
    ]
      .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
      .join('\n')
  }

  // 書く：元の設定ファイルを控えてから、aicarnation の項目だけを足す（入れ替える）
  let backup = ''
  if (read.text !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backup = `${path}.aicarnation-backup-${stamp}`
    await $.fs.write(backup, read.text)
  }
  const next = { ...read.config, mcpServers: { ...servers, aicarnation: entry } }
  await $.fs.write(path, `${JSON.stringify(next, null, 2)}\n`)
  shownDesktopEntry = ''
  return [
    'Claude Desktop の設定ファイルに、アバターの MCP サーバーを登録しました。',
    `設定ファイル：${path}`,
    ...(backup ? [`書き換える前の控え：${backup}`] : []),
    '',
    'Claude Desktop を開き直してから、チャットで「アバターを開いて」と頼んでください。',
    '登録した場所は、プラグインを更新しても変わりません。',
  ].join('\n')
}

function dataDir($: EngineInterface): string {
  return `${storageRoot || $.plugin.root}/data`
}

/** 合言葉のファイル。Claude Desktop の MCP サーバーも同じものを使う */
function tokenFile($: EngineInterface): string {
  return `${storageRoot || $.plugin.root}/token`
}

function engineDir($: EngineInterface): string {
  return `${storageRoot || $.plugin.root}/engines`
}

/**
 * エンジンの実行ファイルを探す。環境変数で指定されていればそれを、無ければ /aicarnation-voice で入れた場所を見る。
 * フォルダの外（公式インストーラーで入れたもの）は、環境変数で指定したときだけ使う
 */
async function findEngine($: EngineInterface, engine: EngineId): Promise<string | null> {
  const own = `${engineDir($)}/${engine}`
  const candidates = [
    await $.env.get('AICARNATION_AIVIS_ENGINE'),
    `${own}/run.exe`,
    `${own}/run`,
  ]
  for (const path of candidates) {
    if (path && (await $.fs.exists(path).catch(() => false))) return path
  }
  return null
}

/**
 * エンジンが入っていれば、セッションの間だけ裏で起動する（セッションが終わると止まる）。
 * 起動するまでの間、画面はブラウザの声で話す
 */
/** 音声エンジンの起動の様子をサーバーに知らせる（画面が、起動を待つかブラウザの声にするかを決める） */
async function reportEngine($: EngineInterface, engine: EngineId, state: 'starting' | 'missing' | 'stopped' | 'restarting'): Promise<void> {
  if (!baseUrl) return
  await $.http
    .fetch(`${baseUrl}/companion/engine`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ engine, state }) })
    .catch(() => undefined)
}

async function startEngine($: EngineInterface, engine: EngineId): Promise<void> {
  if (startedEngines.has(engine)) return
  const path = await findEngine($, engine)
  if (!path) {
    await reportEngine($, engine, 'missing')
    $.ui.toast(`${ENGINE_LABELS[engine]}が見つかりません。/aicarnation-voice install ${engine} で入れるか、起動しておいてください`)
    return
  }
  startedEngines.add(engine)
  await reportEngine($, engine, 'starting')
  $.ui.toast(`${ENGINE_LABELS[engine]}を起動しています…（数十秒かかることがあります）`)
  const child = $.process.spawn({ argv: [path, '--host', '127.0.0.1', '--port', String(ENGINE_PORTS[engine])] })
  let finish = () => {}
  const done = new Promise<void>((resolve) => (finish = resolve))
  let stopping = false
  engineRuns.set(engine, {
    stop: () => {
      stopping = true
      // ループの外から子プロセスを止める（spawn の流れを閉じると子プロセスが終わる）
      void child.return(undefined as never).catch(() => undefined)
    },
    done,
  })
  try {
    // 出力は使わないが、読み続けないと止まってしまうので読み捨てる
    for await (const piece of child) void piece
  } catch {
    if (!stopping) $.ui.toast(`${ENGINE_LABELS[engine]}を起動できませんでした`)
  }
  engineRuns.delete(engine)
  startedEngines.delete(engine)
  await reportEngine($, engine, 'stopped')
  finish()
}

/**
 * 画面の「AivisSpeech を再起動する」から（同梱サーバーの標準出力で、サーバーの持ち主のこの mod に届く）。
 * 動いていれば止めて、起動し直す。声のモデルの一覧が正しく出ないときに使う。
 * 受け付けたことを restarting で知らせ、止まったら stopped、起動し直したら starting になる
 */
async function restartEngine($: EngineInterface, engine: EngineId): Promise<void> {
  if (startedEngines.has(engine) && !engineRuns.has(engine)) {
    $.ui.toast(`${ENGINE_LABELS[engine]}は起動の途中です。少し待ってから試してください`)
    return
  }
  await reportEngine($, engine, 'restarting')
  const run = engineRuns.get(engine)
  if (run) {
    run.stop()
    const stopped = await Promise.race([run.done.then(() => true), $.clock.sleep(20_000).then(() => false)])
    if (!stopped) {
      $.ui.toast(`${ENGINE_LABELS[engine]}を止められませんでした`)
      await reportEngine($, engine, 'stopped')
      return
    }
  }
  await startEngine($, engine)
}

// --- /aicarnation-voice：エンジンのダウンロード（自動では行わず、サイズを見せて確かめてから） ---
interface EngineInfo {
  label: string
  version: string
  name: string
  size: number
  url: string
}
/** install の1回目で見せた内容。2回目（yes つき）はこれと同じものを入れる */
const shownInfo = new Map<EngineId, EngineInfo>()
/** ダウンロード中のエンジン */
const installing = new Set<EngineId>()

const VOICE_USAGE = [
  '使い方：',
  '  /aicarnation-voice                   … エンジンが入っているか確かめる',
  '  /aicarnation-voice install aivis     … AivisSpeech を入れる（サイズを見せて確かめます）',
  '',
  '声は AivisSpeech の音声合成モデル（.aivmx）です。アバターの画面の設定「声のモデル」で入れられます。',
].join('\n')

function megabytes(size: number): string {
  return size >= 1e9 ? `約${(size / 1e9).toFixed(1)}GB` : `約${Math.round(size / 1e6)}MB`
}

function parseEngine(word: string | undefined): EngineId | null {
  const w = (word ?? '').toLowerCase()
  if (w === 'aivis' || w === 'aivisspeech') return 'aivis'
  return null
}

async function voiceStatus($: EngineInterface): Promise<string> {
  const lines = ['ローカル音声エンジン：']
  for (const engine of ['aivis'] as const) {
    const path = await findEngine($, engine)
    const state = installing.has(engine) ? 'ダウンロード中' : path ? `入っています（${path}）` : '入っていません'
    lines.push(`  ${ENGINE_LABELS[engine]}：${state}`)
  }
  lines.push('', `入れる場所：${engineDir($)}`, '', VOICE_USAGE)
  return lines.join('\n')
}

/** 1回目：取得するファイルとサイズを調べて見せる（ダウンロードはしない） */
async function describeInstall($: EngineInterface, engine: EngineId): Promise<string> {
  const { stdout } = await $.process.run([await nodeCommand($), `${$.plugin.root}/server/install-engine.mjs`, 'info', engine], {
    timeoutMs: 30_000,
  })
  let message: Partial<EngineInfo> & { kind?: string; message?: string } = {}
  try {
    message = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as typeof message
  } catch {
    // 下でエラーとして伝える
  }
  if (message.kind !== 'info') return `${ENGINE_LABELS[engine]}の情報を取れませんでした：${message.message ?? '不明なエラー'}`
  const info = message as EngineInfo
  shownInfo.set(engine, info)
  return [
    `${info.label} ${info.version} をダウンロードして入れます。`,
    `  ファイル：${info.name}（${megabytes(info.size)}）`,
    `  取得元：${info.url}`,
    `  入れる場所：${engineDir($)}/${engine}`,
    '',
    `よければ「/aicarnation-voice install ${engine} yes」と入力してください。`,
  ].join('\n')
}

/** 2回目：ダウンロードと展開を裏で行い、進み具合をステータス行に出す */
async function runInstall($: EngineInterface, engine: EngineId, info: EngineInfo): Promise<void> {
  installing.add(engine)
  const label = ENGINE_LABELS[engine]
  const child = $.process.spawn({
    argv: [await nodeCommand($), `${$.plugin.root}/server/install-engine.mjs`, 'install', engine, '--dest', engineDir($)],
  })
  let buffer = ''
  let result: { kind?: string; message?: string; pct?: number } = {}
  try {
    for await (const piece of child) {
      if (piece.stream !== 'stdout') continue
      buffer += piece.text
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        result = parseInstallLine(line) ?? result
        if (result.kind === 'progress') $.ui.status(`アバター：${label}をダウンロード中 ${result.pct ?? 0}%（${megabytes(info.size)}）`)
        else if (result.kind === 'extracting') $.ui.status(`アバター：${label}を展開しています…`)
      }
    }
  } catch {
    result = { kind: 'error', message: 'インストーラーを起動できませんでした' }
  }
  installing.delete(engine)
  shownInfo.delete(engine)
  $.ui.status(baseUrl ? 'アバター：/aicarnation で開けます' : undefined)
  if (result.kind === 'done') $.ui.toast(`${label}を入れました。声の設定で「${label}」を選ぶと使えます`)
  else $.ui.toast(`${label}を入れられませんでした：${result.message ?? '途中で止まりました'}`)
}

function parseInstallLine(line: string): { kind?: string; message?: string; pct?: number } | null {
  try {
    return JSON.parse(line) as { kind?: string; message?: string; pct?: number }
  } catch {
    return null
  }
}

async function voiceCommand($: EngineInterface, args: string): Promise<string> {
  // 保存先が決まる前に入れると、プラグインのフォルダ（更新で消える）に入ってしまう
  if (!storageRoot) return 'まだ準備中です。少し待ってからもう一度実行してください。'
  const [sub, word, confirm] = args.trim().split(/\s+/)
  if (!sub || sub === 'status') return voiceStatus($)
  if (sub !== 'install') return VOICE_USAGE
  const engine = parseEngine(word)
  if (!engine) return VOICE_USAGE
  if (installing.has(engine)) return `${ENGINE_LABELS[engine]}はダウンロード中です。進み具合はステータス行に出ています。`
  const info = shownInfo.get(engine)
  // サイズを見せる前の yes は受け付けない（何を入れるか確かめてもらってから）
  if (confirm?.toLowerCase() !== 'yes' || !info) return describeInstall($, engine)
  void runInstall($, engine, info)
  return `${info.label}（${megabytes(info.size)}）のダウンロードを始めました。終わるとお知らせします。セッションを閉じると止まります。`
}

/** 依頼を取りに行く繰り返しを、このモジュールで動かしているか */
let pollingRequests = false

/**
 * 画面からの依頼（設定の作成・声のおすすめ・台詞帳）を、サーバーへ取りに行って答え続ける。
 * サーバーを起動したのがこのセッションでなくても（Claude Desktop のチャットやほかのセッション）、
 * Claude Code のセッションが動いていれば、そのモデルで答えられるようにするため。
 * サーバーは依頼が来るまで少し待ってから返す（来なければ 204）ので、すぐ次を取りに行く
 */
async function pollRequests($: EngineInterface): Promise<void> {
  if (pollingRequests) return
  pollingRequests = true
  for (;;) {
    if (!baseUrl) {
      await $.clock.sleep(5000)
      continue
    }
    try {
      // 扱える依頼を名乗る（Claude Code を複数開いていて版が混ざっていても、サーバーは扱える mod にだけ渡す）
      const res = await $.http.fetch(`${baseUrl}/companion/requests/next?ops=${REQUEST_OPS.join(',')}`, { headers: authHeaders() })
      if (res.status === 200) {
        const m = JSON.parse(res.text) as { id?: unknown; op?: unknown; payload?: unknown }
        if (typeof m.id === 'string') void answerRequest($, m.id, typeof m.op === 'string' ? m.op : '', m.payload)
      } else if (res.status !== 204) {
        // 古い版のサーバー（取りに行く窓口が無い）や、合言葉の食い違い：少し待ってから試す
        await $.clock.sleep(30_000)
      }
    } catch {
      await $.clock.sleep(3000)
    }
  }
}

/** この mod が答えられる依頼（answerRequest と合わせる） */
const REQUEST_OPS = ['generate-agent', 'suggest-voice', 'generate-lines'] as const

/** 画面からの依頼に Claude Code のモデルで答え、サーバーに返す */
async function answerRequest($: EngineInterface, id: string, op: string, payload: unknown): Promise<void> {
  let body: { id: string; result?: unknown; error?: string }
  try {
    if (op === 'generate-agent') body = { id, result: await generateAgent($, payload) }
    else if (op === 'suggest-voice') body = { id, result: await suggestVoice($, payload) }
    else if (op === 'generate-lines') body = { id, result: await generateLines($, payload) }
    else body = { id, error: `知らない依頼です（${op}）` }
  } catch (err) {
    body = { id, error: err instanceof Error ? err.message : '答えを作れませんでした' }
  }
  if (!baseUrl) return
  await $.http.fetch(`${baseUrl}/companion/answer`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) }).catch(
    () => undefined,
  )
}

/** モデルの返答から最初の JSON オブジェクトを取り出す */
function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('定義を作れませんでした')
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
}

const GENERATE_SYSTEM = `あなたは対話キャラクターの設定を作るアシスタントです。
ユーザーの説明から、3Dアバターとして会話するキャラクターの定義を日本語で作り、次の形の JSON だけを返してください（前後に文章を付けない）。
{"name":"名前","firstPerson":"一人称","tone":"口調（語尾や話し方の特徴を具体的に）","personality":"性格","background":"背景設定（1〜3文）","topics":["得意な話題（2〜5個）"],"forbidden":["会話で避けること（1〜4個）"],"appearance":"見た目（髪色・髪型・服装・雰囲気）","systemPrompt":"キャラクターを演じるための指示文"}
systemPrompt は「あなたは〜です。」と二人称で書き、一人称・口調・性格・背景・得意な話題・避けることをすべて含め、
「返答は1〜3文の短い話し言葉にし、箇条書きや見出しは使わない」ことも書く。感情タグの指示はアプリが付けるので書かない。
説明に口癖・語尾・合いの手・決まった言い回し・話し方の例文が書かれていたら、要約したり言い換えたりせず、書かれた言葉のまま tone と systemPrompt に残す。
systemPrompt の終わり近く（「返答は1〜3文」の指示の前）に「話し方の例：」として、説明にある例文を書かれたとおりに並べる（最大5つ）。説明に例文が無ければ、口調に合う短い例文を3つ作って並べる。
例文のすぐ後に「例文はそのまま繰り返さず、この調子をまねて話す」ことも書く。`
/* 上の3行は packages/shared の AGENT_SPEECH_RULES と同じ内容（mod はアプリのコードを読み込めないため写している） */

async function generateAgent($: EngineInterface, payload: unknown): Promise<unknown> {
  const description = String((payload as { description?: unknown } | null)?.description ?? '').trim()
  if (!description) throw new Error('説明を入力してください')
  const result = await $.model.complete({
    model: 'sonnet',
    system: GENERATE_SYSTEM,
    prompt: description.slice(0, 2000),
    // 口癖や例文を残すと指示文が長くなるので、途中で切れないよう多めにとる
    maxTokens: 4000,
  })
  if (!result.isAnswered) throw new Error('定義を作れませんでした')
  const raw = extractJson(result.text)
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [])
  const agent = {
    name: str(raw.name),
    firstPerson: str(raw.firstPerson),
    tone: str(raw.tone),
    personality: str(raw.personality),
    background: str(raw.background),
    topics: list(raw.topics),
    forbidden: list(raw.forbidden),
    appearance: str(raw.appearance),
    systemPrompt: str(raw.systemPrompt),
  }
  if (!agent.name || !agent.systemPrompt) throw new Error('定義を作れませんでした')
  return agent
}

async function suggestVoice($: EngineInterface, payload: unknown): Promise<unknown> {
  const req = (payload ?? {}) as { agent?: unknown; voices?: unknown }
  const voices = (Array.isArray(req.voices) ? req.voices : []).filter(
    (v): v is VoiceOption => typeof v === 'object' && v !== null && typeof (v as VoiceOption).voiceURI === 'string',
  )
  const fallback = (voices.find((v) => v.lang?.toLowerCase().startsWith('ja')) ?? voices[0])?.voiceURI ?? ''
  if (voices.length === 0) return { voiceURI: '', reason: '使える声がありません' }
  const result = await $.model.complete({
    model: 'haiku',
    system:
      'キャラクターに合う読み上げ音声を、一覧から1つ選んでください。性別感・年齢感・話し方で選び、日本語のキャラクターには日本語（ja）の声を優先します。' +
      '{"voiceURI":"一覧の voiceURI","reason":"選んだ理由（日本語で1文）"} の JSON だけを返してください。',
    prompt: JSON.stringify({ agent: req.agent, voices: voices.slice(0, 80) }),
    maxTokens: 300,
  })
  if (result.isAnswered) {
    try {
      const parsed = extractJson(result.text)
      if (voices.some((v) => v.voiceURI === parsed.voiceURI)) {
        return { voiceURI: parsed.voiceURI, reason: String(parsed.reason ?? '') }
      }
    } catch {
      // 下の代わりの声を返す
    }
  }
  return { voiceURI: fallback, reason: '日本語の声を選びました' }
}

/**
 * 台詞帳を作る：場面ごとに、キャラクターが言う短い台詞を5個ずつ。
 * 画面が場面の一覧（名前と説明）を送ってくるので、mod は場面の中身を知らなくてよい
 */
async function generateLines($: EngineInterface, payload: unknown): Promise<unknown> {
  const req = (payload ?? {}) as { agent?: Record<string, unknown>; scenes?: Record<string, unknown> }
  const scenes = Object.entries(req.scenes ?? {}).filter(([, v]) => typeof v === 'string')
  if (scenes.length === 0) throw new Error('場面がありません')
  const agent = req.agent ?? {}
  const result = await $.model.complete({
    model: 'haiku',
    system: [
      `あなたは「${String(agent.name ?? 'アシスタント')}」というキャラクターです。一人称は「${String(agent.firstPerson ?? 'わたし')}」。`,
      `口調：${String(agent.tone ?? '')}。性格：${String(agent.personality ?? '')}。背景：${String(agent.background ?? '')}。`,
      'あなたは開発者の横で、AI（Claude Code）の作業を一緒に見守っている相棒です。',
      '渡された場面ごとに、あなたが言う短い台詞（30文字以内の話し言葉）を5個ずつ作ってください。',
      'それぞれの台詞の先頭には、感情タグを1つだけ付けます。使えるタグは [happy] [angry] [sad] [relaxed] [surprised] [neutral] のみです。',
      '{"場面の名前":["[happy]台詞", ...], ...} の JSON だけを返してください（前後に文章を付けない）。',
    ].join('\n'),
    prompt: JSON.stringify(Object.fromEntries(scenes)),
    maxTokens: 3000,
  })
  if (!result.isAnswered) throw new Error('台詞帳を作れませんでした')
  return { lines: extractJson(result.text) }
}

/**
 * 利用者がこのセッションで話しかけた。「聞いている」を送る。
 * サーバーが止まっていれば（共用していたほかのセッションのサーバーが止まったなど）起動し直す
 */
async function listen($: EngineInterface, text: string): Promise<void> {
  if (!(await ensureServer($, 3000))) return
  await post($, { type: 'listening', text })
}

async function post($: EngineInterface, event: BridgeEvent): Promise<void> {
  if (!baseUrl) return
  try {
    const res = await $.http.fetch(`${baseUrl}/bridge/event`, {
      method: 'POST',
      headers: { ...authHeaders(), 'x-aicarnation-bridge': '1' },
      body: JSON.stringify(event),
    })
    listeners = res.ok ? Number((JSON.parse(res.text) as { delivered?: number }).delivered ?? 0) : 0
  } catch {
    // 共用していたサーバーが止まった。次に /aicarnation を実行したときに起動し直す
    listeners = 0
    baseUrl = null
  }
}

async function getPersona($: EngineInterface): Promise<Persona | null> {
  if (!baseUrl) return null
  try {
    const res = await $.http.fetch(`${baseUrl}/bridge/persona`, { headers: authHeaders() })
    return res.ok ? (JSON.parse(res.text) as Persona | null) : null
  } catch {
    return null
  }
}

function summarySystem(persona: Persona | null): string {
  const who = persona
    ? `あなたは「${persona.name}」です。一人称は「${persona.firstPerson || 'わたし'}」。口調：${persona.tone}。性格：${persona.personality}。`
    : 'あなたは開発者のそばにいる、丁寧で親しみやすいアシスタントのキャラクターです。'
  return [
    who,
    'あなたは、開発者の横で AI（Claude Code）と一緒に作業している相棒です。',
    'これから渡すのは、Claude Code が開発者に返した返答です。その内容を、あなたが開発者に話しかける1〜3文の短い話し言葉にしてください。',
    '作業をしたのは Claude Code（あなたたち）で、開発者ではありません。「〜しておきました」「〜してみました」のように、こちらがしたこととして伝えてください。',
    '要点（何をしたか・結果・開発者に確かめてほしいこと）だけを伝え、コード・ファイルパス・コマンド・記号は読み上げないでください。',
    '返答そのものだけを書き、前置きや説明は付けないでください。',
    '',
    EMOTION_TAG_INSTRUCTION,
  ].join('\n')
}

async function speakReply($: EngineInterface, answer: string): Promise<void> {
  // アバターが開いていなければ、要約のためのモデル呼び出しはしない
  if (listeners === 0) return
  // 要約ができるまでの数秒、間が空かないよう様子を出しておく
  await post($, { type: 'working', label: 'まとめています' })
  const persona = await getPersona($)
  const result = await $.model.complete({
    model: 'haiku',
    system: summarySystem(persona),
    prompt: answer.slice(0, MAX_ANSWER_CHARS),
    maxTokens: 400,
  })
  if (!result.isAnswered || !result.text.trim()) {
    await post($, { type: 'idle' })
    return
  }
  await post($, { type: 'reply', text: result.text.trim().slice(0, 2000) })
}

/** 既定のブラウザで URL を開く */
async function openInBrowser($: EngineInterface, url: string): Promise<boolean> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  // cmd はシステムのものを名指しする（いまのフォルダに置かれた cmd.exe を動かさないように）
  const systemRoot = (await $.env.get('SystemRoot')) ?? 'C:\\Windows'
  const candidates = isWindows ? [[`${systemRoot}\\System32\\cmd.exe`, '/c', 'start', '', url]] : [['/usr/bin/open', url]]
  for (const argv of candidates) {
    try {
      const { exitCode } = await $.process.run(argv, { timeoutMs: 10_000 })
      if (exitCode === 0) return true
    } catch {
      // 次の方法を試す
    }
  }
  return false
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'aicarnation', description: 'AIcarnation のアバターをブラウザで開く' })
    await $.command.register({
      name: 'aicarnation-desktop',
      description: 'Claude Desktop のチャットでもアバターが反応するよう、Claude Desktop に登録する（確かめてから書きます）',
      argumentHint: '[yes]',
    })
    await $.command.register({
      name: 'aicarnation-voice',
      description: 'アバターの声のエンジン（AivisSpeech）を確かめる・入れる',
      argumentHint: '[install aivis]',
    })
    void startCompanion($)
    void pollRequests($)
    return started
  })

  on('command.run', { command: 'aicarnation' }, async ($) => {
    const url = (await ensureServer($)) ? pageUrl() : null
    if (!url) return { text: serverError ?? 'アバターのサーバーを起動できませんでした。少し待ってからもう一度試すか、Node 18 以上が入っているか確かめてください。' }
    const opened = await openInBrowser($, url)
    return {
      text: opened
        ? `アバターをブラウザで開きました。Chrome / Edge なら「小窓で開く」で常に手前に置けます。\n${url}`
        : `次の URL をブラウザで開いてください（Chrome / Edge 推奨）：\n${url}`,
    }
  })

  on('command.run', { command: 'aicarnation-desktop' }, async ($, e) => {
    try {
      return { text: await desktopCommand($, e.args) }
    } catch (err) {
      return { text: `うまくいきませんでした：${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('command.run', { command: 'aicarnation-voice' }, async ($, e) => {
    try {
      return { text: await voiceCommand($, e.args) }
    } catch (err) {
      return { text: `うまくいきませんでした：${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('prompt.submit', ($, e, next) => {
    // 見えない内部のプロンプトとスラッシュコマンドは送らない。タグは外して文章だけにする
    const text = e.isMeta || e.command ? '' : cleanPromptText(e.text)
    if (text) {
      lastLabel = ''
      void listen($, text.slice(0, MAX_PROMPT_CHARS))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // Claude Desktop に登録したアバターの MCP サーバーは、Claude Desktop の中の Claude Code にも読み込まれる。
    // Claude Code ではこの mod が自動で反応させるので、Claude がツールでも話させると二重になる。呼ばれたら断る
    if (AICARNATION_MCP_TOOL.test(e.tool)) {
      return { deny: 'Claude Code ではアバターは自動で反応します。avatar のツール（aicarnation_listen / aicarnation_say / aicarnation_open）は使わないでください。アバターを開くときは /aicarnation です。' }
    }
    const label = TOOL_LABELS[e.tool] ?? 'ツールを使っています'
    if (label !== lastLabel && listeners > 0) {
      lastLabel = label
      void post($, { type: 'working', label })
    }
    const result = await next(e)
    // コマンドの失敗とテストの結果は、アバターが一言反応できるよう知らせる
    if (listeners > 0 && (e.tool === 'Bash' || e.tool === 'PowerShell')) {
      const kind = noticeFor(e.command, 'isError' in result && result.isError === true)
      if (kind) void post($, { type: 'notice', kind })
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // サブエージェントの返答は送らない。要約は返答を待たせないよう裏で行う
    if (e.agentId === undefined && listeners > 0) {
      if (e.reason === 'answer' && e.answer.trim()) void speakReply($, e.answer)
      else void post($, { type: 'idle' })
    }
    return result
  })
}

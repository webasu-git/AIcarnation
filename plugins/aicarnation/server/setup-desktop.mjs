#!/usr/bin/env node
/**
 * Claude Desktop のチャットでもアバターが反応するよう、Claude Desktop の設定ファイル（claude_desktop_config.json）に
 * アバターの MCP サーバーを登録する。Claude のアプリを終了してから、ターミナルで実行する（Windows は PowerShell）。
 *
 *   node "$HOME/.claude/plugins/marketplaces/aicarnation/plugins/aicarnation/server/setup-desktop.mjs"
 *   （登録を外すときは、最後に --remove を付ける）
 *
 * - Claude のアプリは、終了するときに覚えている設定で設定ファイルを書き直す。起動中に書いても消えるので、起動中なら書かない
 * - 登録するのは、このスクリプトと同じプラグインの MCP サーバー（mcp/aicarnation-mcp.mjs）と、この node 自身の場所。
 *   marketplace add で取り込まれた場所は、marketplace update で中身が新しくなっても変わらないので、登録し直さなくてよい
 * - 書き換える前の設定ファイルを控えに残し、mcpServers.aicarnation だけを足す（あれば入れ替える）。ほかの設定には触らない
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mcpScript = join(pluginRoot, 'mcp', 'aicarnation-mcp.mjs')
const remove = process.argv.includes('--remove')
const force = process.argv.includes('--force')

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

/** Claude Desktop の設定のフォルダ（無ければ null）。Windows の Microsoft Store 版は %LOCALAPPDATA%\Packages\Claude_* の中 */
function configDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData && existsSync(join(appData, 'Claude'))) return join(appData, 'Claude')
    const local = process.env.LOCALAPPDATA
    if (local && existsSync(join(local, 'Packages'))) {
      const store = readdirSync(join(local, 'Packages')).find((name) => name.startsWith('Claude_'))
      const dir = store && join(local, 'Packages', store, 'LocalCache', 'Roaming', 'Claude')
      if (dir && existsSync(dir)) return dir
    }
    return null
  }
  if (process.platform === 'darwin') {
    const dir = join(homedir(), 'Library', 'Application Support', 'Claude')
    return existsSync(dir) ? dir : null
  }
  return null
}

/** Claude のアプリ（Claude Desktop）が起動しているか。ターミナル版の Claude Code とは区別する */
function desktopAppRunning() {
  try {
    if (process.platform === 'darwin') {
      // アプリのプロセス名は「Claude」（ターミナル版は小文字の claude）
      execFileSync('pgrep', ['-x', 'Claude'], { stdio: 'ignore' })
      return true
    }
    if (process.platform === 'win32') {
      // アプリは %LOCALAPPDATA%\AnthropicClaude の中か、Microsoft Store 版（WindowsApps）の claude.exe
      const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const out = execFileSync(
        ps,
        [
          '-NoProfile',
          '-Command',
          "Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*AnthropicClaude*' -or $_.Path -like '*WindowsApps*Claude*' } | Measure-Object | Select-Object -ExpandProperty Count",
        ],
        { encoding: 'utf8' },
      )
      return Number(out.trim()) > 0
    }
  } catch {
    // 見つからない（pgrep は見つからないと失敗で終わる）
  }
  return false
}

const dir = configDir()
if (!dir) {
  fail(
    process.platform === 'win32' || process.platform === 'darwin'
      ? 'Claude Desktop の設定のフォルダが見つかりませんでした。Claude のアプリを入れて一度起動し、終了してから、もう一度実行してください。'
      : 'この OS の Claude Desktop には対応していません（Windows と macOS に対応しています）。',
  )
}
if (!force && desktopAppRunning()) {
  fail(
    'Claude のアプリが起動しています。起動中に登録しても、アプリを終了するときに消えてしまいます。\n' +
      'Claude のアプリを終了してから（Windows はタスクトレイのアイコンから「終了」、Mac は ⌘Q）、もう一度実行してください。',
  )
}

const file = join(dir, 'claude_desktop_config.json')
let text = null
let config = {}
if (existsSync(file)) {
  text = readFileSync(file, 'utf8')
  if (text.trim()) {
    try {
      config = JSON.parse(text)
    } catch {
      fail(`Claude Desktop の設定ファイルを JSON として読めなかったため、書き換えませんでした。\n設定ファイル：${file}`)
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail(`設定ファイルの形が想定と違うため、書き換えませんでした。\n設定ファイル：${file}`)
  }
}
const servers = config.mcpServers && typeof config.mcpServers === 'object' ? { ...config.mcpServers } : {}
const entry = { command: process.execPath, args: [mcpScript] }

if (remove) {
  if (!servers.aicarnation) {
    console.log('\nClaude Desktop には、アバターの MCP サーバーは登録されていません。\n')
    process.exit(0)
  }
  delete servers.aicarnation
} else {
  if (!existsSync(mcpScript)) fail(`アバターの MCP サーバーが見つかりません：${mcpScript}`)
  if (JSON.stringify(servers.aicarnation) === JSON.stringify(entry)) {
    console.log(`\nClaude Desktop には、すでにアバターの MCP サーバーが登録されています。\n設定ファイル：${file}\n`)
    process.exit(0)
  }
  servers.aicarnation = entry
}

// 書き換える前の設定ファイルを控えに残してから書く
let backup = ''
if (text !== null) {
  backup = `${file}.aicarnation-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(file, backup)
}
writeFileSync(file, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`)

console.log(
  [
    '',
    remove ? 'Claude Desktop から、アバターの MCP サーバーの登録を外しました。' : 'Claude Desktop に、アバターの MCP サーバーを登録しました。',
    `設定ファイル：${file}`,
    ...(backup ? [`書き換える前の控え：${backup}`] : []),
    '',
    ...(remove
      ? []
      : ['Claude のアプリを開くと、チャットでもアバターが反応します（チャットで「アバターを開いて」と頼んでください）。', '']),
  ].join('\n'),
)

#!/usr/bin/env node
/**
 * ローカル音声エンジン（AivisSpeech）を GitHub の公式リリースから取ってきて置く。
 * 自動では動かさない。/aicarnation-voice コマンドで、サイズを見せて確かめてから mod が起動する。
 *
 *   node install-engine.mjs info aivis
 *     → 取得するファイルの名前・版・サイズを1行の JSON で出す（ダウンロードはしない）
 *   node install-engine.mjs install aivis --dest <dir>
 *     → <dir>/<engine>/ に展開する。進み具合を1行ずつ JSON で出す
 *        {kind:'progress',pct} {kind:'extracting'} {kind:'done',path,version} {kind:'error',message}
 *
 * 展開は OS の tar（Windows 10 以降と macOS の bsdtar は 7z を読める）を使い、無ければ 7z / 7za を試す。
 * 依存パッケージなし（Node 18 以上）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 試験用に差し替えられるよう、API の場所は環境変数で変えられる */
const API_BASE = process.env.AICARNATION_ENGINE_API ?? 'https://api.github.com'

const ENGINES = {
  aivis: {
    label: 'AivisSpeech',
    repo: 'Aivis-Project/AivisSpeech-Engine',
    asset: { 'win32-x64': /-Windows-x64-.*\.7z\.001$/, 'darwin-arm64': /-macOS-arm64-.*\.7z\.001$/, 'darwin-x64': /-macOS-x64-.*\.7z\.001$/ },
  },
}

const RUN_NAMES = process.platform === 'win32' ? ['run.exe'] : ['run']

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function fail(message) {
  emit({ kind: 'error', message })
  process.exit(1)
}

/** 最新リリースから、この OS 向けのファイルを選ぶ */
async function findAsset(engineId) {
  const engine = ENGINES[engineId]
  if (!engine) throw new Error(`知らないエンジンです（${engineId}）。aivis を指定してください`)
  const pattern = engine.asset[`${process.platform}-${process.arch}`]
  if (!pattern) throw new Error(`この OS（${process.platform}-${process.arch}）には対応していません`)
  const res = await fetch(`${API_BASE}/repos/${engine.repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'aicarnation' },
  })
  if (!res.ok) throw new Error(`リリース情報を取れませんでした（${res.status}）`)
  const release = await res.json()
  const assets = Array.isArray(release.assets) ? release.assets : []
  const asset = assets.find((a) => pattern.test(a.name))
  if (!asset) throw new Error(`${engine.label} の配布ファイルが見つかりません`)
  // .7z.002 があるものは分割されている。結合の手間がかかるので扱わない
  const second = asset.name.replace(/\.001$/, '.002')
  if (assets.some((a) => a.name === second)) throw new Error(`${engine.label} の配布ファイルが分割されているため、自動では入れられません`)
  // 取りに行く先は公式のリリースだけにする。ファイル名はフォルダの区切りを含まない形にする（作業フォルダの外に書かないように）
  const url = String(asset.browser_download_url ?? '')
  if (!url.startsWith(`https://github.com/${engine.repo}/releases/download/`)) throw new Error(`${engine.label} の配布ファイルの取得元が想定と違います`)
  const name = basename(String(asset.name)).replace(/[\\/:*?"<>|]/g, '_')
  // GitHub が示すファイルの SHA-256 があれば、ダウンロードしたものと照らし合わせる
  const sha256 = typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(asset.digest) ? asset.digest.slice(7) : null
  return { engine: engineId, label: engine.label, version: String(release.tag_name ?? ''), name, size: asset.size, url, sha256 }
}

async function download(url, file, total, sha256 = null) {
  const res = await fetch(url, { headers: { 'user-agent': 'aicarnation' } })
  if (!res.ok || !res.body) throw new Error(`ダウンロードできませんでした（${res.status}）`)
  const size = Number(res.headers.get('content-length')) || total
  let received = 0
  let lastPct = -1
  const body = Readable.fromWeb(res.body)
  const hash = createHash('sha256')
  body.on('data', (chunk) => {
    hash.update(chunk)
    received += chunk.length
    const pct = size ? Math.floor((received / size) * 100) : 0
    if (pct !== lastPct) {
      lastPct = pct
      emit({ kind: 'progress', pct, received, total: size })
    }
  })
  await pipeline(body, createWriteStream(file))
  if (size && received !== size) throw new Error('ダウンロードが途中で切れました')
  if (sha256 && hash.digest('hex') !== sha256) throw new Error('ダウンロードしたファイルが公式のものと一致しません（SHA-256 が違います）')
}

/** 展開に使えるコマンドを順に試す */
function extract(archive, into) {
  const tools = []
  if (process.platform === 'win32') {
    // Git Bash などの GNU tar は 7z を読めないので、Windows 標準の tar を名指しする
    const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(systemTar)) tools.push([systemTar, '-xf', archive, '-C', into])
  } else {
    tools.push(['bsdtar', '-xf', archive, '-C', into], ['tar', '-xf', archive, '-C', into])
  }
  tools.push(['7z', 'x', '-y', `-o${into}`, archive], ['7za', 'x', '-y', `-o${into}`, archive])
  for (const [cmd, ...args] of tools) {
    // 作業フォルダで動かす（名前だけのコマンドを、利用者のプロジェクトのフォルダから探さないように）
    const result = spawnSync(cmd, args, { stdio: 'ignore', cwd: dirname(archive) })
    if (result.status === 0) return
  }
  throw new Error('展開できませんでした。7-Zip を入れてからもう一度試してください')
}

/** 展開したフォルダから実行ファイル（run / run.exe）のあるフォルダを探す */
async function findRunDir(dir, depth = 0) {
  const entries = await readdir(dir, { withFileTypes: true })
  if (entries.some((e) => e.isFile() && RUN_NAMES.includes(e.name))) return dir
  if (depth >= 3) return null
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const found = await findRunDir(join(dir, e.name), depth + 1)
    if (found) return found
  }
  return null
}

async function install(engineId, dest) {
  const info = await findAsset(engineId)
  const target = join(dest, engineId)
  const work = join(dest, `.${engineId}-work`)
  await rm(work, { recursive: true, force: true })
  await mkdir(join(work, 'out'), { recursive: true })
  try {
    const archive = join(work, info.name)
    await download(info.url, archive, info.size, info.sha256)
    emit({ kind: 'extracting' })
    extract(archive, join(work, 'out'))
    const runDir = await findRunDir(join(work, 'out'))
    if (!runDir) throw new Error('展開したファイルに実行ファイルが見つかりません')
    if (process.platform !== 'win32') spawnSync('chmod', ['+x', join(runDir, 'run')])
    // 前に入れたものは置き換える（このスクリプトが作ったフォルダだけ）
    await rm(target, { recursive: true, force: true })
    await rename(runDir, target)
    await writeFile(join(target, '.aicarnation-engine.json'), JSON.stringify({ version: info.version, asset: info.name }))
    emit({ kind: 'done', path: join(target, RUN_NAMES[0]), version: info.version })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function main() {
  const [command, engineId, ...rest] = process.argv.slice(2)
  try {
    if (command === 'info') {
      emit({ kind: 'info', ...(await findAsset(engineId)) })
      return
    }
    if (command === 'install') {
      const at = rest.indexOf('--dest')
      const dest = at >= 0 ? rest[at + 1] : undefined
      if (!dest) throw new Error('--dest を指定してください')
      await mkdir(dest, { recursive: true })
      if (!(await stat(dest)).isDirectory()) throw new Error(`${dest} はフォルダではありません`)
      await install(engineId, dest)
      return
    }
    throw new Error('使い方：install-engine.mjs info|install aivis [--dest <dir>]')
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}

await main()

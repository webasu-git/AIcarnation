// Claude Code のセッション記録（~/.claude/projects/<プロジェクト>/*.jsonl）から、利用者の発言と Claude の最後の返事だけを取り出す。
// 放置中の逆提案の材料に足す（既定はオフ。オンにすると、すべてのプロジェクトの最近の記録を見る）。
//
// - 見るのは、最近更新された記録を新しい順に数個。読ませたくないフォルダは設定で除外できる
//   （フォルダ名は Claude Code と同じ規則＝英数字以外を - に置き換える、で比べる）
// - 記録は大きくなる（数十〜数百 MB）ので、ファイルの終わりの一部だけを読む
// - ツールの呼び出し・結果、サブエージェントのやり取り、内部メモは入れない
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { cleanText, localStamp } from './conversation-log.mjs'

export const SESSION_DEFAULTS = {
  /** 何日前までの記録を見るか（今日を1日目として数える） */
  days: 3,
  /** すべてのプロジェクトを通して、新しく更新された記録から何ファイルまで見るか */
  maxFiles: 8,
  /** 1ファイルにつき、終わりから何バイトまで読むか */
  tailBytes: 6_000_000,
  /** 入れる行数の上限（新しいものを優先） */
  maxLines: 60,
  /** 1件の長さの上限 */
  maxLineChars: 400,
}

/** Claude Code の設定フォルダ（~/.claude。CLAUDE_CONFIG_DIR があればそれ） */
export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

/**
 * プロジェクトのフォルダのパスから、記録のフォルダ名を求める（英数字以外を - に置き換える）。
 * 例：D:\Dev\my app → D--Dev-my-app。区切りが残らないので、projects の外は指せない
 */
export function projectFolderName(projectDir) {
  return String(projectDir)
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/[^A-Za-z0-9]/g, '-')
}

/** ファイルの終わりの maxBytes だけを読む。途中から読んだときは、切れた最初の行を捨てる */
async function readTail(file, maxBytes) {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await handle.close()
  }
}

/** メッセージの中身から、文章だけを取り出す（ツールの呼び出し・結果・画像は入れない） */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/** ツールの結果を運ぶだけのメッセージか（利用者の発言ではない） */
const isToolResult = (content) => Array.isArray(content) && content.some((part) => part?.type === 'tool_result')

/**
 * 記録の行（JSONL の文字列）から、利用者の発言と、発言ごとの Claude の最後の返事を取り出す。
 * 返すのは [{ ts（ISO）, who: 'user' | 'claude', text }] の並び（古い順）
 */
export function extractTurns(raw) {
  const turns = []
  /** 今のやり取りで、Claude が最後に書いた文章 */
  let lastAnswer = null
  const flush = () => {
    if (lastAnswer) turns.push(lastAnswer)
    lastAnswer = null
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let j
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (j.isSidechain || j.isMeta || j.isCompactSummary || typeof j.timestamp !== 'string') continue
    const content = j.message?.content
    if (j.type === 'user') {
      if (isToolResult(content)) continue
      // スラッシュコマンドや内部メモだけの入力は、文章にすると空になる
      const text = cleanText(textOf(content))
      if (!text) continue
      flush()
      turns.push({ ts: j.timestamp, who: 'user', text })
    } else if (j.type === 'assistant') {
      const text = cleanText(textOf(content))
      if (text) lastAnswer = { ts: j.timestamp, who: 'claude', text }
    }
  }
  flush()
  return turns
}

/** 除外するフォルダ（とその下のフォルダ）の記録か。記録のフォルダ名どうしで比べる */
function isExcluded(folderName, excludeDirs) {
  return excludeDirs.some((dir) => {
    const name = projectFolderName(dir)
    return name !== '' && (folderName === name || folderName.startsWith(`${name}-`))
  })
}

/**
 * すべてのプロジェクトから、最近のセッション記録を集める（どのフォルダで作業していても、全体を見渡せるように）。
 * 新しく更新された記録から maxFiles 個を選び、利用者の発言と Claude の最後の返事を取り出す。
 * excludeDirs に書いたフォルダ（とその下）の記録は読まない。
 * 返すのは [{ project（作業フォルダの名前）, ts, who, text }] の並び（古い順、maxLines まで）。読めないものは飛ばす
 */
export async function collectSessionTurns(excludeDirs = [], options = {}, now = new Date(), configDir = claudeConfigDir()) {
  const o = { ...SESSION_DEFAULTS, ...options }
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (o.days - 1)).getTime()
  const root = join(configDir, 'projects')
  let files = []
  let folders = []
  try {
    folders = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  for (const folder of folders) {
    if (!folder.isDirectory() || isExcluded(folder.name, excludeDirs)) continue
    try {
      for (const entry of await readdir(join(root, folder.name))) {
        if (!entry.endsWith('.jsonl')) continue
        const file = join(root, folder.name, entry)
        const info = await stat(file)
        if (info.isFile() && info.mtimeMs >= since) files.push({ file, folder: folder.name, mtime: info.mtimeMs })
      }
    } catch {
      // 読めないフォルダは飛ばす
    }
  }
  files = files.sort((a, b) => b.mtime - a.mtime).slice(0, o.maxFiles)
  const all = []
  for (const { file, folder } of files) {
    try {
      const raw = await readTail(file, o.tailBytes)
      // 作業フォルダの名前は、記録の中の cwd から取る（フォルダ名からは元のパスに戻せないため）
      const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1]
      const project = cwd ? basename(JSON.parse(`"${cwd}"`).replace(/[\\/]+$/, '')) || folder : folder
      for (const turn of extractTurns(raw)) {
        if (Date.parse(turn.ts) >= since) all.push({ project, ...turn })
      }
    } catch {
      // 読めないファイルは飛ばす
    }
  }
  all.sort((a, b) => a.ts.localeCompare(b.ts))
  return all.slice(-o.maxLines).map((t) => ({ ...t, ts: localStamp(new Date(t.ts)).ts, text: t.text.length > o.maxLineChars ? `${t.text.slice(0, o.maxLineChars)}…` : t.text }))
}

// 会話の記録。Claude Code・Claude Desktop のチャットから届いた「聞いている（発言）」と「返事」の合図を、
// 日付ごとの JSONL に追記する。放置中の逆提案（アバターから話しかける）の材料にする。
//
//   <data>/logs/conversation/YYYY-MM-DD.jsonl（動いている PC のタイムゾーンで日付を切る）
//   {"ts":"2026-11-23T02:46:12+09:00","type":"heard","text":"…"}
//   {"ts":"2026-11-23T02:46:15+09:00","type":"reply","emotion":"relaxed","text":"…","segments":[{"emotion":"relaxed","text":"…"}]}
//
// 記録は手元のフォルダにだけ置き、どこにも送らない。記録するかと残す日数は画面の設定（settings ストア）で決める。
// API キーなどの秘密らしき文字列は、伏せてから書く（redact.mjs）。フォルダとファイルは、自分だけが読める権限で作る
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { redact } from './redact.mjs'

export const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral']
/** 1件の記録に残す長さの上限（発言には貼り付けた長い文章も入るため） */
export const MAX_LOG_TEXT = 1000
export const DEFAULT_RETENTION_DAYS = 30
const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const pad = (n) => String(n).padStart(2, '0')

/**
 * 動いている PC のタイムゾーン（OS の設定。環境変数 TZ があればそれ）での「YYYY-MM-DD」と、
 * 時差付きの時刻「YYYY-MM-DDTHH:mm:ss+09:00」
 */
export function localStamp(date) {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const ts = `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return { day, ts }
}

/** Claude Code の入力に混ざる内部メモ（中身ごと消す） */
const HIDDEN_BLOCKS = ['system-reminder', 'local-command-caveat', 'local-command-stdout', 'command-name', 'command-message', 'command-args']

/**
 * 整形にかける入力の長さの上限。残すのは MAX_LOG_TEXT までなので、先に切ってから整形する。
 * 貼り付けた数 MB のログなど、長い入力に正規表現をかけると、中身によっては時間が長さの 2 乗でかかり、サーバーが止まる
 */
const MAX_CLEAN_INPUT = 8000

/** 内部メモ（<tag …>…</tag>）を中身ごと消す。閉じていないものは残す。正規表現を使わず、前から順に探す */
function removeHiddenBlocks(text) {
  let out = text
  for (const tag of HIDDEN_BLOCKS) {
    const open = `<${tag}`
    const close = `</${tag}>`
    let from = 0
    for (;;) {
      const start = out.indexOf(open, from)
      if (start < 0) break
      // <tag> か <tag 属性…> だけ（<tag-other> のような別の名前は対象外）
      const next = out[start + open.length]
      if (next !== '>' && next !== ' ' && next !== '\t' && next !== '\n') {
        from = start + open.length
        continue
      }
      const openEnd = out.indexOf('>', start)
      const end = openEnd < 0 ? -1 : out.indexOf(close, openEnd)
      // 閉じるタグが無ければ、この先にも無い
      if (end < 0) break
      out = `${out.slice(0, start)} ${out.slice(end + close.length)}`
      from = start
    }
  }
  return out
}

/**
 * 記録に残す自然な文章だけにする：内部メモを消し、タグを外し、空白を整え、秘密らしき文字列を伏せ、長すぎれば切る。
 * 伏せるのは切る前（切れ目にかかった秘密の残りが、伏せる条件から外れないように）
 */
export function cleanText(text) {
  const lines = removeHiddenBlocks(String(text).slice(0, MAX_CLEAN_INPUT))
    .replace(/<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    // 行ごとに前後の空白を落とし、空の行をまとめる（改行のまわりの空白を正規表現で探すと、空白の長い並びで遅くなる）
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const out = redact(lines.join('\n'))
  return out.length > MAX_LOG_TEXT ? `${out.slice(0, MAX_LOG_TEXT)}…` : out
}

/**
 * 返事を感情タグごとに分ける。「[happy] よかった。[sad] でも…」→ [{happy, よかった。}, {sad, でも…}]。
 * タグの無い文頭は neutral。知らないタグはそのまま文に残す
 */
export function splitEmotions(text) {
  const segments = []
  let emotion = 'neutral'
  let rest = String(text)
  const tag = /\[(happy|angry|sad|relaxed|surprised|neutral)\]/g
  let last = 0
  for (const m of rest.matchAll(tag)) {
    const before = rest.slice(last, m.index).trim()
    if (before) segments.push({ emotion, text: before })
    emotion = m[1]
    last = m.index + m[0].length
  }
  rest = rest.slice(last).trim()
  if (rest) segments.push({ emotion, text: rest })
  return segments
}

/** 合図を記録の1行にする。記録しない合図なら null */
export function toRecord(event, date = new Date()) {
  const { ts } = localStamp(date)
  if (event?.type === 'listening') {
    const text = cleanText(event.text)
    return text ? { ts, type: 'heard', text } : null
  }
  if (event?.type === 'reply') {
    const segments = splitEmotions(event.text)
      .map((s) => ({ emotion: s.emotion, text: cleanText(s.text) }))
      .filter((s) => s.text)
    if (segments.length === 0) return null
    const record = { ts, type: 'reply', emotion: segments[0].emotion, text: cleanText(segments.map((s) => s.text).join(' ')) }
    if (segments.length > 1) record.segments = segments
    return record
  }
  return null
}

/** 残す日数を 1〜365 に収める。設定が無い・おかしいときは既定の日数 */
export function retentionDays(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.min(365, Math.floor(n)) : DEFAULT_RETENTION_DAYS
}

/**
 * 会話の記録。now は時刻の取り方（試すとき用）
 */
export function createConversationLog(dataDir, now = () => new Date()) {
  const dir = join(dataDir, 'logs', 'conversation')
  /** 書き込みは1つずつ順に行う（行が混ざらないように） */
  let writing = Promise.resolve()
  /** 最後に古い記録を消した日（1日1回だけ消す） */
  let prunedDay = null

  /** 残す日数より古い日のファイルを消す。今日を1日目として数える */
  async function prune(days) {
    const keep = retentionDays(days)
    const date = now()
    const today = localStamp(date).day
    // その PC の暦で（keep - 1）日前。夏時間の切り替わりでずれないよう、時刻ではなく日付で数える
    const oldest = localStamp(new Date(date.getFullYear(), date.getMonth(), date.getDate() - (keep - 1), 12)).day
    let names = []
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const removed = []
    for (const name of names) {
      const m = name.match(FILE_PATTERN)
      if (m && m[1] < oldest) {
        await rm(join(dir, name), { force: true })
        removed.push(name)
      }
    }
    prunedDay = today
    return removed
  }

  /** 合図を記録する（記録しない合図なら何もしない）。日が変わって最初の記録の前に、古い記録を消す */
  function append(event, days) {
    const date = now()
    const record = toRecord(event, date)
    if (!record) return writing
    const { day } = localStamp(date)
    writing = writing
      .then(async () => {
        if (prunedDay !== day) await prune(days)
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await appendFile(join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
      })
      .catch(() => undefined)
    return writing
  }

  return { dir, append, prune }
}

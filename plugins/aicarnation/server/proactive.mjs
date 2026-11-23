// 放置中の逆提案（アバターから話しかける）の材料集めと、返ってきた提案の検証。
// 材料はここ（サーバー）で集めて伏せ字にし、Claude Code の mod に渡す。mod のモデルは「読んで、考えて、文章を返す」だけ。
//
//   材料：会話の記録（<data>/logs/conversation/*.jsonl、直近の数日）・過去の提案（<data>/logs/suggestions.jsonl）・今の時刻
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EMOTIONS, localStamp } from './conversation-log.mjs'
import { redact } from './redact.mjs'
import { collectSessionTurns } from './session-records.mjs'

export const PROACTIVE_OP = 'suggest-proactive'
export const DEFAULTS = {
  /** 会話の記録を何日分まで見るか（今日を1日目として数える） */
  conversationDays: 3,
  /** 会話の記録の行数の上限（新しいものを優先） */
  conversationMaxLines: 200,
  /** 過去の提案を何件まで見るか */
  suggestionHistory: 20,
  /** 材料全体の文字数の上限（超えた分は古い会話から削る） */
  maxContextChars: 20_000,
  /** 材料に入れる1件の長さ（長い発言で、ほかの会話が押し出されないように） */
  maxLineChars: 400,
  /** Claude Code のセッション記録（すべてのプロジェクトの最近のもの）も材料にするか。設定でオンにしたときだけ */
  sessionsEnabled: false,
  /** セッション記録を読ませないフォルダ（とその下） */
  sessionExcludeDirs: [],
  /** セッション記録に使う文字数の上限（会話の記録を押し出しすぎないように） */
  sessionMaxChars: 10_000,
  /** セッション記録の1件の長さ（直近 30 往復ほどが収まるよう、会話の記録より短くする） */
  sessionLineChars: 300,
}
/** 提案の文の長さの上限 */
export const MAX_SUGGESTION_CHARS = 120
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

// 伏せ字は redact.mjs（会話の記録を書くときにも使う）。ここからも呼べるようにしておく
export { redact }

/** JSONL を読む（無い・壊れた行は飛ばす） */
async function readJsonl(file) {
  let raw = ''
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return out
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)
/** 「2026-11-23T03:22:18+09:00」→「11/23 03:22」 */
const shortTime = (ts) => (typeof ts === 'string' && ts.length >= 16 ? `${ts.slice(5, 7)}/${ts.slice(8, 10)} ${ts.slice(11, 16)}` : '')

/**
 * 逆提案の材料を集める。返すのは、そのままプロンプトに差し込める文章
 * { now: '2026-11-23（月）03:22', conversation: '[11/23 03:22 ユーザー] …\n…', suggestions: '…', lines: 件数 }
 */
export async function collectMaterials(dataDir, options = {}, now = new Date()) {
  const o = { ...DEFAULTS, ...options }
  const stamp = localStamp(now)
  const logDir = join(dataDir, 'logs', 'conversation')

  // 直近の数日のファイル（古い順）
  const oldest = localStamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (o.conversationDays - 1), 12)).day
  let names = []
  try {
    names = (await readdir(logDir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) >= oldest && n.slice(0, 10) <= stamp.day).sort()
  } catch {
    // 記録がまだ無い
  }
  let lines = []
  for (const name of names) {
    for (const r of await readJsonl(join(logDir, name))) {
      if ((r.type !== 'heard' && r.type !== 'reply') || typeof r.text !== 'string') continue
      const who = r.type === 'heard' ? 'ユーザー' : 'アバター'
      lines.push(`[${shortTime(r.ts)} ${who}] ${clip(redact(r.text).replace(/\s*\n\s*/g, ' '), o.maxLineChars)}`)
    }
  }
  lines = lines.slice(-o.conversationMaxLines)

  // 過去の提案（実際に話したものだけ。新しい順に数えて、古い順に並べる）
  const past = (await readJsonl(join(dataDir, 'logs', 'suggestions.jsonl')))
    .filter((r) => r.propose === true && r.spoken === true && typeof r.text === 'string')
    .slice(-o.suggestionHistory)
    .map((r) => `[${shortTime(r.ts)}] ${clip(redact(r.text), o.maxLineChars)}`)
  const suggestions = past.join('\n')

  // Claude Code での作業（すべてのプロジェクトの最近の記録。新しいものを優先して、上限に収める）
  const sessionLines = []
  if (o.sessionsEnabled) {
    const turns = await collectSessionTurns(o.sessionExcludeDirs, { days: o.conversationDays, maxLineChars: o.sessionLineChars }, now, o.claudeConfigDir)
    let room = o.sessionMaxChars
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]
      const line = `[${shortTime(t.ts)} ${t.project} ${t.who === 'user' ? 'ユーザー' : 'Claude'}] ${redact(t.text).replace(/\s*\n\s*/g, ' ')}`
      room -= line.length + 1
      if (room < 0) break
      sessionLines.unshift(line)
    }
  }
  const sessions = sessionLines.join('\n')

  // 全体の上限に収める（古い会話から削る）
  let budget = o.maxContextChars - suggestions.length - sessions.length
  const kept = []
  for (let i = lines.length - 1; i >= 0; i--) {
    budget -= lines[i].length + 1
    if (budget < 0) break
    kept.unshift(lines[i])
  }

  return {
    now: `${stamp.day}（${WEEKDAYS[now.getDay()]}）${stamp.ts.slice(11, 16)}`,
    conversation: kept.join('\n'),
    suggestions,
    sessions,
    lines: kept.length,
    sessionLines: sessionLines.length,
  }
}

/** 感情タグ・改行を除いて、話す文だけにする */
function cleanSpeech(text) {
  return String(text)
    .replace(/\[(?:happy|angry|sad|relaxed|surprised|neutral)\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * モデルの答えを検証する。形がおかしい・文が空・長すぎる・感情が不正なら、すべて「提案なし」にする。
 * 返すのは { propose: true, emotion, text, reason } か { propose: false, reason }
 */
export function validateSuggestion(raw) {
  const none = (reason) => ({ propose: false, reason })
  if (typeof raw !== 'object' || raw === null) return none('答えの形が不正です')
  const reason = typeof raw.reason === 'string' ? clip(raw.reason.trim(), 300) : ''
  if (raw.propose !== true) return none(raw.propose === false ? reason : '答えの形が不正です')
  if (typeof raw.text !== 'string') return none('提案の文がありません')
  const text = cleanSpeech(raw.text)
  if (!text) return none('提案の文が空です')
  if (text.length > MAX_SUGGESTION_CHARS) return none(`提案の文が長すぎます（${text.length} 文字）`)
  if (!EMOTIONS.includes(raw.emotion)) return none('感情が不正です')
  return { propose: true, emotion: raw.emotion, text, reason }
}

// --- 出す頻度の決まりと、提案の記録（<data>/logs/suggestions.jsonl） ---

/**
 * 既定では、間隔も 1 日の回数も制限しない。話しかける頻度は、画面の「話しかけるまでの時間」（放置がその長さ続いたら 1 度だけ話す）で決まる。
 * 別に間隔や回数を絞りたいときだけ、設定（proactiveCooldownMin・proactiveMaxPerDay）に値を入れる
 */
export const GATE_DEFAULTS = {
  /** 逆提案どうしの最低の間隔（分）。0 なら制限しない */
  cooldownMin: 0,
  /** 1日に話す逆提案の上限。Infinity なら制限しない */
  maxPerDay: Infinity,
  /** 提案を出さない時間帯（"23:00-07:00" の並び。日をまたいでよい） */
  quietHours: [],
}
/** 話したあと、この時間のうちに利用者の発言があれば「反応があった」と記録する */
export const RESPONSE_WINDOW_MS = 5 * 60_000

const num = (v, fallback, min, max) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= min ? Math.min(max, n) : fallback
}

/** 設定の値（無い・おかしいときは既定）を、出す頻度の決まりにする */
export function gateOptions(cooldownMin, maxPerDay, quietHours) {
  return {
    cooldownMin: num(cooldownMin, GATE_DEFAULTS.cooldownMin, 0, 24 * 60),
    maxPerDay: num(maxPerDay, GATE_DEFAULTS.maxPerDay, 1, 1000),
    quietHours: Array.isArray(quietHours) ? quietHours.filter((s) => typeof s === 'string') : [],
  }
}

/** 今が、出さない時間帯（"HH:MM-HH:MM"。終わりが始まりより前なら日をまたぐ）に入っているか */
export function inQuietHours(ranges, date) {
  const minutes = date.getHours() * 60 + date.getMinutes()
  for (const range of ranges) {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(range.trim())
    if (!m) continue
    const start = Number(m[1]) * 60 + Number(m[2])
    const end = Number(m[3]) * 60 + Number(m[4])
    if (start === end) continue
    if (start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end) return true
  }
  return false
}

/**
 * 今、逆提案を作ってよいか。だめなら理由（作らない＝モデルを呼ばない）、よければ null。
 * records は提案の記録（話したものだけを数える）
 */
export function gateReason(records, options, now) {
  const o = { ...GATE_DEFAULTS, ...options }
  if (inQuietHours(o.quietHours, now)) return '提案を出さない時間帯です'
  const spoken = records.filter((r) => r.propose === true && r.spoken === true && typeof r.ts === 'string')
  const last = spoken.at(-1)
  if (last && o.cooldownMin > 0) {
    const since = now.getTime() - Date.parse(last.ts)
    if (since >= 0 && since < o.cooldownMin * 60_000) return `前の提案から ${o.cooldownMin} 分たっていません`
  }
  if (Number.isFinite(o.maxPerDay)) {
    const today = localStamp(now).day
    if (spoken.filter((r) => r.ts.slice(0, 10) === today).length >= o.maxPerDay) return `今日の上限（${o.maxPerDay} 回）に達しました`
  }
  return null
}

/** 提案の記録。書き込みは1つずつ順に行う */
export function createSuggestionLog(dataDir, now = () => new Date()) {
  const dir = join(dataDir, 'logs')
  const file = join(dir, 'suggestions.jsonl')
  let writing = Promise.resolve()
  /** 最後に話した提案（反応を待っている間だけ覚える） */
  let awaiting = null

  const queue = (work) => {
    writing = writing.then(work).catch(() => undefined)
    return writing
  }

  return {
    file,
    read: () => readJsonl(file),
    /** 提案の結果を1行残す。話したもの（spoken）は、このあと反応を待つ */
    append(suggestion, spoken) {
      const date = now()
      const record = {
        ts: localStamp(date).ts,
        propose: suggestion.propose === true,
        emotion: suggestion.emotion ?? null,
        text: suggestion.text ?? '',
        reason: suggestion.reason ?? '',
        spoken,
        user_responded_within_5min: false,
      }
      if (spoken) awaiting = { ts: record.ts, until: date.getTime() + RESPONSE_WINDOW_MS }
      return queue(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
      })
    },
    /** 利用者の発言があった。話した提案から 5 分以内なら、その行に「反応があった」と書く */
    userSpoke() {
      const waiting = awaiting
      awaiting = null
      if (!waiting || now().getTime() > waiting.until) return writing
      return queue(async () => {
        const lines = (await readFile(file, 'utf8')).split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].trim()) continue
          const r = JSON.parse(lines[i])
          if (r.ts === waiting.ts && r.spoken === true) {
            lines[i] = JSON.stringify({ ...r, user_responded_within_5min: true })
            await writeFile(file, lines.join('\n'), 'utf8')
            return
          }
        }
      })
    },
  }
}

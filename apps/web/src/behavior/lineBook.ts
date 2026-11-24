import type { AgentDefinition } from '@aicarnation/shared'
import { generateLines } from '../api/agents'
import { IS_COMPANION, companionFetch } from '../runtime'
import { withRetry } from '../retry'
import { DEFAULT_LINES, SCENES, normalizeLineBook, personaSignature, type LineBook } from './lines'

/** 同梱サーバーに保存する台詞帳（エージェントごと） */
interface StoredLineBook {
  agentId: string
  /** 作ったときの人柄。変わっていたら作り直す */
  signature: string
  lines: LineBook
  createdAt: string
}

/** 保存してある台詞帳。無ければ null。読めなければ（一時的につながらないなど）間を空けて読み直し、それでもだめなら失敗を返す */
async function getStored(agentId: string): Promise<StoredLineBook | null> {
  const found = await withRetry(async () => {
    const res = await companionFetch(`/store/lines/${encodeURIComponent(agentId)}`)
    if (res.status === 404) return null
    // 読めなかった：無いとみなして作り直すと、保存済みの台詞帳を上書きしてしまう
    if (!res.ok) throw new Error(`台詞帳を読めませんでした（${res.status}）`)
    return (await res.json()) as StoredLineBook
  })
  return found ?? null
}

/** 台詞帳を保存する。保存できなかったら間を空けてやり直す（作った台詞帳は、保存できなくてもこの画面では使う。次に開いたときに作り直す） */
async function putStored(book: StoredLineBook): Promise<void> {
  await withRetry(async () => {
    const res = await companionFetch(`/store/lines/${encodeURIComponent(book.agentId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(book),
    })
    if (!res.ok) throw new Error(`台詞帳を保存できませんでした（${res.status}）`)
  }).catch(() => undefined)
}

/** 作っている最中の台詞帳（キャラクターと人柄ごと。同じものを続けて頼まれたら、1 回の作成を分け合う） */
const loading = new Map<string, Promise<LineBook>>()
/** キャラクターごとの、最後に頼まれた人柄（古い人柄で作った台詞帳を、新しいものの上に保存しない） */
const latestSignature = new Map<string, string>()

/**
 * エージェントの台詞帳。同梱版は、保存してあればそれを、無いか人柄が変わっていれば
 * Claude Code のモデルで1回だけ作って保存する。開発版・作れなかったときは既定の台詞。
 * generate が false なら作らない（画面が複数開いているとき、声を出す画面だけが作る）
 */
export function loadLineBook(agent: AgentDefinition, { generate = true }: { generate?: boolean } = {}): Promise<LineBook> {
  if (!IS_COMPANION) return Promise.resolve(DEFAULT_LINES)
  const signature = personaSignature(agent)
  latestSignature.set(agent.id, signature)
  const key = `${agent.id}\n${signature}\n${generate}`
  const running = loading.get(key)
  if (running) return running
  const task = loadOrCreate(agent, signature, generate).finally(() => loading.delete(key))
  loading.set(key, task)
  return task
}

async function loadOrCreate(agent: AgentDefinition, signature: string, generate: boolean): Promise<LineBook> {
  try {
    const stored = await getStored(agent.id)
    if (stored && stored.signature === signature) return normalizeLineBook(stored.lines)
    if (!generate) return DEFAULT_LINES
    const raw = await generateLines({
      agent: {
        name: agent.name,
        firstPerson: agent.firstPerson,
        tone: agent.tone,
        personality: agent.personality,
        background: agent.background,
      },
      scenes: { ...SCENES },
    })
    const lines = normalizeLineBook((raw as { lines?: unknown } | null)?.lines ?? raw)
    // 作っている間に人柄が変わっていたら、古い人柄の台詞帳は保存しない（新しい人柄のものを上書きしないように）
    if (latestSignature.get(agent.id) === signature) {
      await putStored({ agentId: agent.id, signature, lines, createdAt: new Date().toISOString() })
    }
    return lines
  } catch {
    return DEFAULT_LINES
  }
}

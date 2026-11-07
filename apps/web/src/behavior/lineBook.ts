import type { AgentDefinition } from '@aicarnation/shared'
import { generateLines } from '../api/agents'
import { IS_COMPANION, companionHeaders } from '../runtime'
import { DEFAULT_LINES, SCENES, normalizeLineBook, personaSignature, type LineBook } from './lines'

/** 同梱サーバーに保存する台詞帳（エージェントごと） */
interface StoredLineBook {
  agentId: string
  /** 作ったときの人柄。変わっていたら作り直す */
  signature: string
  lines: LineBook
  createdAt: string
}

async function getStored(agentId: string): Promise<StoredLineBook | null> {
  const res = await fetch(`/store/lines/${encodeURIComponent(agentId)}`, { headers: companionHeaders() })
  return res.ok ? ((await res.json()) as StoredLineBook) : null
}

async function putStored(book: StoredLineBook): Promise<void> {
  await fetch(`/store/lines/${encodeURIComponent(book.agentId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...companionHeaders() },
    body: JSON.stringify(book),
  })
}

/**
 * エージェントの台詞帳。同梱版は、保存してあればそれを、無いか人柄が変わっていれば
 * Claude Code のモデルで1回だけ作って保存する。開発版・作れなかったときは既定の台詞
 */
export async function loadLineBook(agent: AgentDefinition): Promise<LineBook> {
  if (!IS_COMPANION) return DEFAULT_LINES
  const signature = personaSignature(agent)
  try {
    const stored = await getStored(agent.id)
    if (stored && stored.signature === signature) return normalizeLineBook(stored.lines)
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
    await putStored({ agentId: agent.id, signature, lines, createdAt: new Date().toISOString() })
    return lines
  } catch {
    return DEFAULT_LINES
  }
}

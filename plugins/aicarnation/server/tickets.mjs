// 画面を開く URL に入れる、使い捨ての券。
// 合言葉そのものを URL に入れると、Claude Code のセッション記録やブラウザの履歴に残る。
// 代わりに、短い時間・1 回だけ使える券を URL に入れ、画面が開いたときに合言葉と引き換える。
import { randomBytes } from 'node:crypto'

/** 券を使える時間 */
export const TICKET_TTL_MS = 120_000
/** 同時に持っておく券の数の上限（古いものから捨てる） */
const MAX_TICKETS = 20

export function createTickets({ ttlMs = TICKET_TTL_MS, now = () => Date.now() } = {}) {
  /** 券 → 使える期限 */
  const tickets = new Map()

  function sweep() {
    const t = now()
    for (const [ticket, expires] of tickets) if (expires <= t) tickets.delete(ticket)
    while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value)
  }

  return {
    /** 新しい券を出す */
    issue() {
      sweep()
      const ticket = randomBytes(16).toString('hex')
      tickets.set(ticket, now() + ttlMs)
      return ticket
    },
    /** 券を使う。使えれば true（使った券は消える。期限切れ・知らない券は false） */
    redeem(ticket) {
      if (typeof ticket !== 'string' || !/^[0-9a-f]{32}$/.test(ticket)) return false
      const expires = tickets.get(ticket)
      tickets.delete(ticket)
      return expires !== undefined && expires > now()
    },
  }
}

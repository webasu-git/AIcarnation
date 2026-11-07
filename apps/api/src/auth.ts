import { createMiddleware } from 'hono/factory'
import type { AppEnv } from './env'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function bearer(header: string | undefined): string | null {
  const id = header?.match(/^Bearer (.+)$/)?.[1]
  return id && UUID_RE.test(id) ? id.toLowerCase() : null
}

/**
 * 認証はここに集約する。いまは匿名ID。
 * Cloudflare Access 等に替えるときはこのファイルだけを差し替える。
 *
 * requireRegistered=false は /auth/anon 用（登録前のIDを受け付ける）
 */
export function auth({ requireRegistered = true } = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const anonId = bearer(c.req.header('Authorization'))
    if (!anonId) {
      return c.json({ code: 'unauthorized', message: '匿名IDがありません' }, 401)
    }
    if (requireRegistered) {
      const user = await c.env.DB.prepare('SELECT 1 FROM users WHERE anon_id = ?').bind(anonId).first()
      if (!user) {
        return c.json({ code: 'unauthorized', message: '匿名IDが登録されていません' }, 401)
      }
    }
    c.set('anonId', anonId)
    await next()
  })
}

export async function registerAnon(db: D1Database, anonId: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO users (anon_id, created_at) VALUES (?, ?)')
    .bind(anonId, new Date().toISOString())
    .run()
}

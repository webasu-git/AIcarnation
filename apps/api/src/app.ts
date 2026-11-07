import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv, Env } from './env'
import { auth, registerAnon } from './auth'
import { chatRoutes } from './chat'
import { agentRoutes } from './agents'
import type { ChatModel } from './claude'
import type { AgentGenerator } from './generator'
import type { VoiceSuggester } from './voice'

/** ALLOWED_ORIGINS（カンマ区切り）を配列にする。空要素と末尾のスラッシュは除く */
export function allowedOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

export interface AppDeps {
  getModel: (env: Env) => ChatModel
  getGenerator: (env: Env) => AgentGenerator
  getVoiceSuggester: (env: Env) => VoiceSuggester
}

export function createApp({ getModel, getGenerator, getVoiceSuggester }: AppDeps) {
  const app = new Hono<AppEnv>()

  /**
   * CORS は自アプリのオリジンだけ許可する。
   * ブラウザから別のオリジンで呼ばれたら、CORS ヘッダーを返さないだけでなく 403 で断る。
   * Origin ヘッダーが無いリクエスト（同一オリジンのプロキシ経由・サーバー間）はそのまま通す
   */
  app.use('*', async (c, next) => {
    const allowed = allowedOrigins(c.env.ALLOWED_ORIGINS)
    const origin = c.req.header('Origin')
    if (origin && !allowed.includes(origin) && c.req.method !== 'OPTIONS') {
      return c.json({ code: 'forbidden_origin', message: 'このオリジンからは利用できません' }, 403)
    }
    return cors({
      origin: (o) => (allowed.includes(o) ? o : null),
      allowHeaders: ['Authorization', 'Content-Type'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    })(c, next)
  })

  // 本文の大きさに上限を設ける（読み込む前に断る）。画像を送るエージェント生成だけ大きめにする
  const tooLarge = (c: Context<AppEnv>) => c.json({ code: 'invalid_request', message: '送られた内容が大きすぎます' }, 413)
  const smallBody = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge })
  const imageBody = bodyLimit({ maxSize: 22 * 1024 * 1024, onError: tooLarge })
  app.use('*', (c, next) => (c.req.path === '/agents/generate' ? imageBody(c, next) : smallBody(c, next)))

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/auth/anon', auth({ requireRegistered: false }), async (c) => {
    await registerAnon(c.env.DB, c.get('anonId'))
    return c.json({ ok: true })
  })

  app.use('/chat', auth())
  app.use('/usage', auth())
  app.use('/agents/*', auth())
  app.route('/', chatRoutes(getModel))
  app.route('/', agentRoutes(getGenerator, getVoiceSuggester))

  return app
}

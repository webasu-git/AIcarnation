import { Hono } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import {
  MAX_CHAT_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
  type ChatRequest,
  type ChatStreamEvent,
} from '@aicarnation/shared'
import type { AppEnv, Env } from './env'
import { classifyClaudeError, type ChatModel } from './claude'
import { withGuard } from './guard'
import { USAGE_LIMIT_MESSAGE, getUsage, nextResetJst, reserveUsage } from './usage'

/** リクエストを検証する。問題があれば理由を返す */
export function validateChatRequest(body: unknown): { ok: true; value: ChatRequest } | { ok: false; reason: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'JSON の形が不正です' }
  const { agentId, systemPrompt, messages } = body as Record<string, unknown>
  if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 100) {
    return { ok: false, reason: 'agentId が不正です' }
  }
  if (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    return { ok: false, reason: `systemPrompt は ${MAX_SYSTEM_PROMPT_CHARS} 文字までです` }
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_CHAT_MESSAGES) {
    return { ok: false, reason: `messages は 1〜${MAX_CHAT_MESSAGES} 件です` }
  }
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) return { ok: false, reason: 'messages の要素が不正です' }
    const { role, content } = m as Record<string, unknown>
    if (role !== 'user' && role !== 'assistant') return { ok: false, reason: 'role が不正です' }
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { ok: false, reason: '空のメッセージは送れません' }
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return { ok: false, reason: `1メッセージは ${MAX_MESSAGE_CHARS} 文字までです` }
    }
  }
  const list = messages as ChatRequest['messages']
  if (list[0]?.role !== 'user' || list.at(-1)?.role !== 'user') {
    return { ok: false, reason: '最初と最後のメッセージはユーザーの発言にしてください' }
  }
  return { ok: true, value: { agentId, systemPrompt, messages: list } }
}

async function send(stream: SSEStreamingApi, e: ChatStreamEvent): Promise<void> {
  await stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) })
}

/** ログには会話本文を残さない（匿名ID・時刻・トークン数のみ） */
function logUsage(anonId: string, inputTokens: number, outputTokens: number) {
  console.log(JSON.stringify({ type: 'chat', anonId, at: new Date().toISOString(), inputTokens, outputTokens }))
}

export function chatRoutes(getModel: (env: Env) => ChatModel) {
  const app = new Hono<AppEnv>()

  app.post('/chat', async (c) => {
    const parsed = validateChatRequest(await c.req.json().catch(() => null))
    if (!parsed.ok) return c.json({ code: 'invalid_request', message: parsed.reason }, 400)

    const anonId = c.get('anonId')
    const { systemPrompt, messages } = parsed.value
    let model: ChatModel
    try {
      model = getModel(c.env)
    } catch {
      return c.json({ code: 'upstream_error', message: 'サーバーの設定が不足しています' }, 500)
    }
    // モデルを呼ぶ前に1回分を数える（途中で切っても数え漏れないように。失敗しても戻さない）
    if (!(await reserveUsage(c.env, anonId))) {
      return c.json({ code: 'usage_limit', message: USAGE_LIMIT_MESSAGE, resetsAt: nextResetJst() }, 429)
    }

    return streamSSE(c, async (stream) => {
      try {
        const result = await model.stream(
          { system: withGuard(systemPrompt), messages, signal: c.req.raw.signal },
          (text) => send(stream, { event: 'delta', data: { text } }),
        )
        if (result.stopReason === 'refusal') {
          await send(stream, { event: 'error', data: { code: 'refusal', message: 'その話題にはお答えできません' } })
        } else {
          await send(stream, { event: 'done', data: { stopReason: result.stopReason } })
        }
        logUsage(anonId, result.inputTokens, result.outputTokens)
      } catch (err) {
        const code = classifyClaudeError(err)
        const message = code === 'upstream_busy' ? '混み合っています。少し待ってから送ってください' : '応答を作れませんでした'
        console.log(JSON.stringify({ type: 'chat_error', anonId, at: new Date().toISOString(), code }))
        await send(stream, { event: 'error', data: { code, message } })
      }
    })
  })

  app.get('/usage', async (c) => c.json(await getUsage(c.env, c.get('anonId'))))

  return app
}

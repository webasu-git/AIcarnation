import type { ChatRequest, ChatStreamEvent } from '@aicarnation/shared'
import { ApiError, apiFetch, errorFromResponse } from '../api/client'

export interface ChatStreamHandlers {
  onDelta(text: string): void
}

/**
 * /chat に送り、SSE を受けながら onDelta を呼ぶ。完了で resolve、失敗は ApiError で reject。
 */
export async function streamChat(req: ChatRequest, handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<void> {
  const res = await apiFetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  })
  if (!res.ok || !res.body) throw await errorFromResponse(res)

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const event = parseEvent(buffer.slice(0, sep))
        buffer = buffer.slice(sep + 2)
        if (!event) continue
        if (event.event === 'delta') handlers.onDelta(event.data.text)
        else if (event.event === 'error') throw new ApiError(event.data.code, event.data.message)
        else if (event.event === 'done') return
      }
    }
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('network', '通信が途中で切れました')
  }
  throw new ApiError('network', '応答が途中で終わりました')
}

function parseEvent(block: string): ChatStreamEvent | null {
  let event = ''
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (!event || !data) return null
  try {
    return { event, data: JSON.parse(data) } as ChatStreamEvent
  } catch {
    return null
  }
}

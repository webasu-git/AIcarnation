import Anthropic from '@anthropic-ai/sdk'
import type { ChatErrorCode, ChatMessage } from '@aicarnation/shared'

export interface ChatStreamResult {
  stopReason: string | null
  inputTokens: number
  outputTokens: number
}

export interface ChatStreamParams {
  system: string
  messages: ChatMessage[]
  signal?: AbortSignal
}

/** 会話モデル。テストではモックに差し替える */
export interface ChatModel {
  stream(params: ChatStreamParams, onText: (text: string) => Promise<void>): Promise<ChatStreamResult>
}

/** 会話は短文中心なので余裕を持たせつつ大きくしすぎない */
const MAX_TOKENS = 4096

export function createClaudeModel(apiKey: string, model: string): ChatModel {
  const client = new Anthropic({ apiKey })
  return {
    async stream({ system, messages, signal }, onText) {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: MAX_TOKENS,
          system,
          messages,
          // 会話は応答の速さを優先する
          output_config: { effort: 'low' },
          // システムプロンプトと履歴の先頭は毎回同じなのでキャッシュさせる
          cache_control: { type: 'ephemeral' },
        },
        { signal },
      )
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          await onText(event.delta.text)
        }
      }
      const final = await stream.finalMessage()
      return {
        stopReason: final.stop_reason,
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      }
    },
  }
}

/** Claude API のエラーを、利用者向けのエラーコードに振り分ける */
export function classifyClaudeError(err: unknown): ChatErrorCode {
  if (err instanceof Anthropic.RateLimitError) return 'upstream_busy'
  if (err instanceof Anthropic.InternalServerError) return 'upstream_busy'
  return 'upstream_error'
}

const MOCK_REPLIES = [
  '[happy]こんにちは！お話しできてうれしいです。[neutral]今日はどんなことをしましたか？',
  '[surprised]えっ、そうなんですか！[relaxed]それは楽しそうですね。',
  '[sad]それは大変でしたね。[neutral]少し休めるといいのですが。',
  '[angry]それはひどいです！[relaxed]でも、あなたが無事でよかったです。',
]

/**
 * API キー無しで画面を確かめるためのモック（MOCK_CLAUDE=true のときだけ使う）。
 * 感情タグ付きの定型文を少しずつ流す
 */
export function createMockModel(): ChatModel {
  let turn = 0
  return {
    async stream({ signal }, onText) {
      const reply = MOCK_REPLIES[turn++ % MOCK_REPLIES.length] ?? ''
      for (let i = 0; i < reply.length; i += 3) {
        if (signal?.aborted) break
        await onText(reply.slice(i, i + 3))
        await new Promise((r) => setTimeout(r, 30))
      }
      return { stopReason: 'end_turn', inputTokens: 0, outputTokens: 0 }
    },
  }
}

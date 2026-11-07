import Anthropic from '@anthropic-ai/sdk'
import type { SuggestVoiceRequest, SuggestVoiceResponse } from '@aicarnation/shared'

/** 声の推薦。テストではモックに差し替える */
export interface VoiceSuggester {
  suggest(req: SuggestVoiceRequest): Promise<SuggestVoiceResponse>
}

const SYSTEM_PROMPT = `あなたはキャラクターに合う読み上げ音声を選ぶアシスタントです。
ブラウザで使える声の一覧から、キャラクターの性別感・年齢感・話し方に最も合う声を1つ選んでください。
日本語のキャラクターには日本語（ja）の声を優先します。reason には選んだ理由を日本語で1文で書いてください。`

/** 一覧に無い声を返されたときや、推薦できないときの代わり：日本語の声、無ければ先頭 */
export function fallbackVoice(req: SuggestVoiceRequest): string {
  return (req.voices.find((v) => v.lang.toLowerCase().startsWith('ja')) ?? req.voices[0])?.voiceURI ?? ''
}

export function createClaudeVoiceSuggester(apiKey: string, model: string): VoiceSuggester {
  const client = new Anthropic({ apiKey })
  return {
    async suggest(req) {
      const message = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(req) }],
        output_config: {
          effort: 'low',
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                voiceURI: { type: 'string', enum: req.voices.map((v) => v.voiceURI) },
                reason: { type: 'string' },
              },
              required: ['voiceURI', 'reason'],
              additionalProperties: false,
            },
          },
        },
      })
      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      try {
        const parsed = JSON.parse(text) as Partial<SuggestVoiceResponse>
        if (req.voices.some((v) => v.voiceURI === parsed.voiceURI)) {
          return { voiceURI: parsed.voiceURI as string, reason: String(parsed.reason ?? '') }
        }
      } catch {
        // 下の代わりの声を返す
      }
      return { voiceURI: fallbackVoice(req), reason: '日本語の声を選びました' }
    },
  }
}

/** API キー無しで画面を確かめるためのモック（MOCK_CLAUDE=true のときだけ使う） */
export function createMockVoiceSuggester(): VoiceSuggester {
  return {
    async suggest(req) {
      return { voiceURI: fallbackVoice(req), reason: '（モック）日本語の声を選びました' }
    },
  }
}

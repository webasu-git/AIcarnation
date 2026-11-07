/** 応答の各文頭に付ける感情タグ。VRMの標準表情名と一致させている */
export const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'] as const

export type Emotion = (typeof EMOTIONS)[number]

export const DEFAULT_EMOTION: Emotion = 'neutral'

export function isEmotion(value: string): value is Emotion {
  return (EMOTIONS as readonly string[]).includes(value)
}

/** エージェントのシステムプロンプトに必ず含める、感情タグの指示文 */
export const EMOTION_TAG_INSTRUCTION = [
  '応答の各文の先頭に、その文の感情を表すタグを1つだけ付けてください。',
  `使えるタグは ${EMOTIONS.map((e) => `[${e}]`).join(' ')} のみです。`,
  '例：[happy]それはいいですね！[neutral]詳しく教えてください。',
].join('\n')

/** システムプロンプトに感情タグの指示が無ければ末尾に足す */
export function withEmotionInstruction(systemPrompt: string): string {
  const body = systemPrompt.trim()
  return body.includes(EMOTION_TAG_INSTRUCTION) ? body : `${body}\n\n${EMOTION_TAG_INSTRUCTION}`
}

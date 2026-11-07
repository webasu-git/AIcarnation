import { EMOTIONS, isEmotion, type Emotion } from '@aicarnation/shared'

/** 読み上げ・表情切り替えの単位になる1文 */
export interface Sentence {
  /** 文頭の感情タグ。無ければ null（直前の表情を続ける） */
  emotion: Emotion | null
  text: string
}

const TERMINATORS = new Set(['。', '！', '？', '!', '?', '\n'])
/** 文末記号の直後に続いても同じ文に含める文字 */
const TRAILERS = new Set(['。', '！', '？', '!', '?', '」', '』', '）', ')', '…'])
const TAG_RE = new RegExp(`^\\[(${EMOTIONS.join('|')})\\]`)
const MAX_TAG_LENGTH = Math.max(...EMOTIONS.map((e) => e.length)) + 2

/**
 * ストリームで届く応答を、感情タグ付きの文に切り分ける。
 * チャンクの境目でタグや文が途切れても正しく扱えるよう、未確定の部分は持ち越す。
 */
export class EmotionStreamParser {
  private buffer = ''
  private text = ''
  private emotion: Emotion | null = null

  push(chunk: string): Sentence[] {
    this.buffer += chunk
    return this.drain(false)
  }

  /** ストリームの終わりに呼び、残りを1文として出す */
  flush(): Sentence[] {
    const out = this.drain(true)
    this.emit(out)
    return out
  }

  private drain(final: boolean): Sentence[] {
    const out: Sentence[] = []
    let i = 0
    while (i < this.buffer.length) {
      const rest = this.buffer.slice(i)
      const ch = rest[0] ?? ''

      if (ch === '[') {
        const tag = rest.match(TAG_RE)
        if (tag) {
          // 文の途中に来たタグは、そこで文を区切る
          this.emit(out)
          this.emotion = tag[1] as Emotion
          i += tag[0].length
          continue
        }
        // タグの書きかけかもしれないので、続きが届くまで待つ
        if (!final && !rest.includes(']') && rest.length < MAX_TAG_LENGTH && isTagPrefix(rest)) break
      }

      if (TERMINATORS.has(ch)) {
        let end = i + 1
        while (end < this.buffer.length && TRAILERS.has(this.buffer[end] ?? '')) end++
        // 文末記号でバッファが終わったら、閉じ括弧などが続く可能性があるので待つ
        if (!final && end === this.buffer.length) break
        if (ch !== '\n') this.text += this.buffer.slice(i, end)
        this.emit(out)
        i = end
        continue
      }

      this.text += ch
      i++
    }
    this.buffer = this.buffer.slice(i)
    return out
  }

  private emit(out: Sentence[]): void {
    const text = this.text.trim()
    this.text = ''
    if (!text) return
    out.push({ emotion: this.emotion, text })
    this.emotion = null
  }
}

function isTagPrefix(s: string): boolean {
  const body = s.slice(1)
  return EMOTIONS.some((e) => e.startsWith(body))
}

/** 保存済みの応答から感情タグを除いて表示用の文にする */
export function stripEmotionTags(content: string): string {
  return content.replace(new RegExp(`\\[(${EMOTIONS.join('|')})\\]`, 'g'), '').trim()
}

/** 応答の最後に使われた感情。無ければ null */
export function lastEmotion(content: string): Emotion | null {
  const all = [...content.matchAll(new RegExp(`\\[(${EMOTIONS.join('|')})\\]`, 'g'))]
  const last = all.at(-1)?.[1]
  return last && isEmotion(last) ? last : null
}

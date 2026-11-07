import { describe, expect, it } from 'vitest'
import { EmotionStreamParser, lastEmotion, stripEmotionTags, type Sentence } from './emotionParser'

function parseChunks(chunks: string[]): Sentence[] {
  const parser = new EmotionStreamParser()
  return [...chunks.flatMap((c) => parser.push(c)), ...parser.flush()]
}

describe('EmotionStreamParser', () => {
  it('文頭のタグを感情として取り出し、句点で文を区切る', () => {
    expect(parseChunks(['[happy]こんにちは！[neutral]元気ですか？'])).toEqual([
      { emotion: 'happy', text: 'こんにちは！' },
      { emotion: 'neutral', text: '元気ですか？' },
    ])
  })

  it('チャンクの境目でタグが途切れても扱える', () => {
    expect(parseChunks(['[ha', 'ppy]や', 'あ。[s', 'ad]ふむ。'])).toEqual([
      { emotion: 'happy', text: 'やあ。' },
      { emotion: 'sad', text: 'ふむ。' },
    ])
  })

  it('タグの無い文は emotion が null', () => {
    expect(parseChunks(['[happy]一文目。二文目。'])).toEqual([
      { emotion: 'happy', text: '一文目。' },
      { emotion: null, text: '二文目。' },
    ])
  })

  it('閉じ括弧や連続した記号は同じ文に含める', () => {
    expect(parseChunks(['[surprised]「本当？」', 'と聞いた！！次。'])).toEqual([
      { emotion: 'surprised', text: '「本当？」' },
      { emotion: null, text: 'と聞いた！！' },
      { emotion: null, text: '次。' },
    ])
  })

  it('知らないタグや角括弧はそのまま文字として残す', () => {
    expect(parseChunks(['[joy]これは[注記]です。'])).toEqual([{ emotion: null, text: '[joy]これは[注記]です。' }])
  })

  it('文末記号が無くても flush で残りを出す', () => {
    const parser = new EmotionStreamParser()
    expect(parser.push('[relaxed]おしまい')).toEqual([])
    expect(parser.flush()).toEqual([{ emotion: 'relaxed', text: 'おしまい' }])
  })

  it('改行は文の区切りとして扱い、本文には含めない', () => {
    expect(parseChunks(['[happy]一行目\n二行目'])).toEqual([
      { emotion: 'happy', text: '一行目' },
      { emotion: null, text: '二行目' },
    ])
  })

  it('文の途中のタグはそこで文を区切る', () => {
    expect(parseChunks(['ええと[angry]だめです。'])).toEqual([
      { emotion: null, text: 'ええと' },
      { emotion: 'angry', text: 'だめです。' },
    ])
  })
})

describe('stripEmotionTags / lastEmotion', () => {
  it('タグを除き、最後の感情を返す', () => {
    const content = '[happy]やった！[sad]でも残念。'
    expect(stripEmotionTags(content)).toBe('やった！でも残念。')
    expect(lastEmotion(content)).toBe('sad')
    expect(lastEmotion('タグなし')).toBeNull()
  })
})

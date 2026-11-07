import { describe, expect, it } from 'vitest'
import { recognitionLangFrom } from './recognition'

describe('recognitionLangFrom（音声入力の言語をブラウザの言語に合わせる）', () => {
  it('ブラウザのいちばん好みの言語を使う', () => {
    expect(recognitionLangFrom(['en-US', 'ja-JP'], 'en-US')).toBe('en-US')
  })

  it('好みの言語の一覧が無ければ、ブラウザの言語を使う', () => {
    expect(recognitionLangFrom([], 'ja')).toBe('ja')
  })

  it('どちらも分からなければ日本語', () => {
    expect(recognitionLangFrom(undefined, '')).toBe('ja-JP')
  })
})

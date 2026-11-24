import { describe, expect, it } from 'vitest'
import { DEFAULT_BACKGROUND_COLOR, DEFAULT_VOICE, normalizeAgentDefinition, validateAgentDefinition } from '@aicarnation/shared'

/** 中継 API の同期（PUT /agents/:id）で使う検証。読み込みの検証と同じ決まりにそろえる */
const base = {
  id: 'a',
  name: 'サンプル',
  firstPerson: '私',
  tone: '',
  personality: '',
  background: '',
  systemPrompt: '',
  appearance: '',
  createdAt: '',
  updatedAt: '',
  topics: [],
  forbidden: [],
  vrm: { source: 'none', ref: '' },
  voice: { ...DEFAULT_VOICE },
}

describe('validateAgentDefinition', () => {
  it('正しい定義は通す', () => {
    expect(validateAgentDefinition(base)).toBeNull()
    expect(validateAgentDefinition({ ...base, backdrop: { kind: 'color', color: '#aabbcc' } })).toBeNull()
  })

  it('声の数値は、画面で選べる範囲の数だけを受け付ける', () => {
    for (const voice of [{ rate: 0 }, { rate: Number.NaN }, { pitch: 3 }, { intonation: -1 }, { tempo: 9 }, { emotional: 'yes' }]) {
      expect(validateAgentDefinition({ ...base, voice: { ...base.voice, ...voice } }), JSON.stringify(voice)).toBe('voice の指定が不正です')
    }
  })

  it('背景の色は色の番号だけ、画像の見せ方は数だけを受け付ける', () => {
    expect(validateAgentDefinition({ ...base, backdrop: { kind: 'color', color: 'url(https://example.com/x)' } })).toBe('backdrop の指定が不正です')
    expect(
      validateAgentDefinition({ ...base, backdrop: { kind: 'image', fileId: 'f', name: 'n', media: 'image', zoom: 'big' } }),
    ).toBe('backdrop の指定が不正です')
  })

  it('前の版で入った範囲外の値は、今の決まりに合う値に直す（直したものは同期の検証を通る）', () => {
    const old = { ...base, voice: { voiceURI: 'x', rate: 3, pitch: -1, intonation: 9 }, backdrop: { kind: 'color', color: 'red' } } as never
    const fixed = normalizeAgentDefinition(old) as unknown as typeof base & { backdrop: { color: string }; voice: Record<string, number> }
    expect(fixed.voice).toMatchObject({ voiceURI: 'x', rate: 2, pitch: 0, intonation: 2 })
    expect(fixed.backdrop.color).toBe(DEFAULT_BACKGROUND_COLOR)
    expect(validateAgentDefinition(fixed)).toBeNull()
  })
})

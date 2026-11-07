import { describe, expect, it } from 'vitest'
import { MAX_BRIDGE_TEXT_CHARS, cleanPromptText, parseBridgeEvent, parseBridgePersona } from '@aicarnation/shared'

describe('cleanPromptText', () => {
  it('貼り付けの囲みを外して中の文章を残す', () => {
    const text = '<pasted_content id="6d0a">\nデザインは大丈夫でした。\n</pasted_content id="6d0a">'
    expect(cleanPromptText(text)).toBe('デザインは大丈夫でした。')
  })

  it('内部メモのタグは中身ごと消す', () => {
    const text = '<system-reminder>\n内部の注意書き\n</system-reminder>\n直してください'
    expect(cleanPromptText(text)).toBe('直してください')
  })

  it('普通の文章や不等号はそのまま', () => {
    expect(cleanPromptText('a < b なら直す')).toBe('a < b なら直す')
    expect(cleanPromptText('  ログイン画面を  直して  ')).toBe('ログイン画面を 直して')
  })

  it('タグだけなら空になる', () => {
    expect(cleanPromptText('<local-command-caveat>注意</local-command-caveat>')).toBe('')
  })
})

describe('parseBridgeEvent', () => {
  it('4種類の合図を受け付ける', () => {
    expect(parseBridgeEvent({ type: 'listening', text: '直して' })).toEqual({ type: 'listening', text: '直して' })
    expect(parseBridgeEvent({ type: 'working', label: '探しています' })).toEqual({ type: 'working', label: '探しています' })
    expect(parseBridgeEvent({ type: 'reply', text: '[happy]できました' })).toEqual({ type: 'reply', text: '[happy]できました' })
    expect(parseBridgeEvent({ type: 'idle', extra: 1 })).toEqual({ type: 'idle' })
  })

  it('形が違う・長すぎる・空の返答は null', () => {
    expect(parseBridgeEvent(null)).toBeNull()
    expect(parseBridgeEvent({ type: 'unknown' })).toBeNull()
    expect(parseBridgeEvent({ type: 'listening' })).toBeNull()
    expect(parseBridgeEvent({ type: 'reply', text: '   ' })).toBeNull()
    expect(parseBridgeEvent({ type: 'reply', text: 'あ'.repeat(MAX_BRIDGE_TEXT_CHARS + 1) })).toBeNull()
    expect(parseBridgeEvent({ type: 'working', label: 'x'.repeat(101) })).toBeNull()
  })
})

describe('parseBridgePersona', () => {
  it('4項目そろっていれば受け付け、余計な項目は落とす', () => {
    const persona = { name: 'ミナ', firstPerson: 'わたし', tone: '丁寧', personality: '好奇心旺盛' }
    expect(parseBridgePersona({ ...persona, systemPrompt: '無視される' })).toEqual(persona)
    expect(parseBridgePersona({ name: 'ミナ' })).toBeNull()
  })
})

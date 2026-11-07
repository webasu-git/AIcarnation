import { describe, expect, it } from 'vitest'
import { engineVoiceURI, isKatakana, licenseNameOf, parseEngineVoiceURI, timeMoras, toKatakana, type Synthesized } from './engines'
import { visemeForVowel } from '../chat/lipSync'

const audio = new ArrayBuffer(0)

describe('engineVoiceURI / parseEngineVoiceURI', () => {
  it('エンジンとスタイルIDを往復できる。ブラウザの声は null', () => {
    expect(parseEngineVoiceURI(engineVoiceURI('aivis', 888753760))).toEqual({ engine: 'aivis', styleId: 888753760 })
    expect(parseEngineVoiceURI('Microsoft Haruka - Japanese (Japan)')).toBeNull()
    expect(parseEngineVoiceURI('')).toBeNull()
  })
})

describe('timeMoras', () => {
  it('拍の長さを返すエンジン：拍の長さどおりに、前の無音のあとから並べる', () => {
    const s: Synthesized = {
      audio,
      moras: [
        { vowel: 'a', length: 0.1 },
        { vowel: 'pau', length: 0.3 },
        { vowel: 'i', length: 0.2 },
      ],
      pre: 0.1,
      post: 0.1,
    }
    expect(timeMoras(s, 0.8).map((m) => [m.vowel, +m.at.toFixed(2), +m.duration.toFixed(2)])).toEqual([
      ['a', 0.1, 0.1],
      ['pau', 0.2, 0.3],
      ['i', 0.5, 0.2],
    ])
  })

  it('AivisSpeech（長さ 0）：音声の長さを拍に割り振り、息継ぎは少し長めにとる', () => {
    const s: Synthesized = {
      audio,
      moras: [
        { vowel: 'a', length: 0 },
        { vowel: 'pau', length: 0 },
        { vowel: 'o', length: 0 },
      ],
      pre: 0.1,
      post: 0.1,
    }
    const timed = timeMoras(s, 1.1) // 前後を除いて 0.9 秒を 1 : 1.5 : 1 で割る
    expect(timed.map((m) => +m.duration.toFixed(3))).toEqual([0.257, 0.386, 0.257])
    expect(+timed[2]!.at.toFixed(3)).toBe(0.743)
  })
})

describe('visemeForVowel', () => {
  it('母音を口形にし、無声化は小さく、撥音はほぼ閉じ、促音と息継ぎは閉じる', () => {
    expect(visemeForVowel('a')?.viseme).toBe('aa')
    expect(visemeForVowel('U')?.scale).toBeLessThan(visemeForVowel('u')!.scale)
    expect(visemeForVowel('N')).toEqual({ viseme: 'ou', scale: 0.2 })
    expect(visemeForVowel('cl')).toBeNull()
    expect(visemeForVowel('pau')).toBeNull()
  })
})

describe('licenseNameOf（ライセンスの名前）', () => {
  it('全文の最初の見出しを名前にする。無ければ記載なし', () => {
    expect(licenseNameOf('# Aivis Common Model License (ACML) 1.0\n\nこのライセンスは…')).toBe('Aivis Common Model License (ACML) 1.0')
    expect(licenseNameOf('\nCC0 1.0 Universal\n本文')).toBe('CC0 1.0 Universal')
    expect(licenseNameOf('')).toBe('（記載なし）')
  })
})

describe('読みの辞書の読み', () => {
  it('ひらがなはカタカナに直し、前後の空白を除く', () => {
    expect(toKatakana(' しののめ ')).toBe('シノノメ')
    expect(toKatakana('ヴァイオリン')).toBe('ヴァイオリン')
  })

  it('カタカナ（長音・小さい文字を含む）だけを読みとして認める', () => {
    expect(isKatakana('シノノメ')).toBe(true)
    expect(isKatakana('コーヒー')).toBe(true)
    expect(isKatakana('Shinonome')).toBe(false)
    expect(isKatakana('シノ ノメ')).toBe(false)
  })
})

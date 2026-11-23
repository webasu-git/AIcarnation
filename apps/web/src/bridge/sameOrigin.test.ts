import { describe, expect, it } from 'vitest'
import { isCrossSite } from '../../bridge/sameOrigin'

describe('isCrossSite', () => {
  it('この開発サーバーの画面からの呼び出しは通す', () => {
    expect(isCrossSite({ origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' }, 5173)).toBe(false)
    expect(isCrossSite({ origin: 'http://127.0.0.1:5173' }, 5173)).toBe(false)
    // 同じオリジンの GET には Origin が付かない。ブラウザ以外（curl など）も付けない
    expect(isCrossSite({}, 5173)).toBe(false)
    expect(isCrossSite({ 'sec-fetch-site': 'same-origin' }, 5173)).toBe(false)
  })

  it('ほかのサイトからの呼び出しは断る', () => {
    expect(isCrossSite({ origin: 'https://evil.example' }, 5173)).toBe(true)
    expect(isCrossSite({ origin: 'http://localhost:9999' }, 5173)).toBe(true)
    expect(isCrossSite({ origin: 'null' }, 5173)).toBe(true)
    // 画像の読み込みや no-cors の GET は Origin が付かないが、ブラウザが cross-site と知らせる
    expect(isCrossSite({ 'sec-fetch-site': 'cross-site' }, 5173)).toBe(true)
    expect(isCrossSite({ origin: ['https://evil.example'] }, 5173)).toBe(true)
  })
})

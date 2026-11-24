import { describe, expect, it } from 'vitest'
import { laterDelay, retryTiming, withRetry } from './retry'

describe('やり直し', () => {
  it('保存し直しの間隔は、失敗が続くほど倍にし、上限で止める', () => {
    const { resaveLater, resaveLaterMax } = retryTiming
    expect(laterDelay(0)).toBe(resaveLater)
    expect(laterDelay(1)).toBe(resaveLater * 2)
    expect(laterDelay(30)).toBe(resaveLaterMax)
  })

  it('決まった回数だけやり直し、だめなら失敗を返す。新しい依頼が来たらやめる', async () => {
    const saved = retryTiming.delays
    retryTiming.delays = [0, 0, 0]
    try {
      let calls = 0
      await expect(withRetry(async () => { calls++; throw new Error('x') })).rejects.toThrow('x')
      expect(calls).toBe(4)
      calls = 0
      expect(await withRetry(async () => { calls++; throw new Error('x') }, () => false)).toBeUndefined()
      expect(calls).toBe(1)
    } finally {
      retryTiming.delays = saved
    }
  })
})

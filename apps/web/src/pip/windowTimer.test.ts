import { afterEach, describe, expect, it, vi } from 'vitest'
import { setWindowTimeout } from './windowTimer'

/** 小窓の window の代わり：タイマーと pagehide だけを持つ。閉じたらタイマーは動かない */
function fakePipWindow() {
  const listeners = new Map<string, () => void>()
  let closed = false
  const win = {
    get closed() {
      return closed
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(() => !closed && fn(), ms),
    clearTimeout: (id: number) => clearTimeout(id),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  }
  const close = () => {
    closed = true
    listeners.get('pagehide')?.()
  }
  return { win: win as unknown as Window, close }
}

describe('setWindowTimeout（小窓の window のタイマー）', () => {
  afterEach(() => vi.useRealTimers())

  it('小窓が開いている間は、小窓のタイマーで動く', () => {
    vi.useFakeTimers()
    const { win } = fakePipWindow()
    const fn = vi.fn()
    setWindowTimeout(win, fn, 100)
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('途中で小窓を閉じても、本体の window で残りを待って動く', () => {
    vi.useFakeTimers()
    const { win, close } = fakePipWindow()
    const fn = vi.fn()
    setWindowTimeout(win, fn, 100)
    vi.advanceTimersByTime(40)
    close()
    vi.advanceTimersByTime(59)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('取り消せば、小窓を閉じたあとも動かない', () => {
    vi.useFakeTimers()
    const { win, close } = fakePipWindow()
    const fn = vi.fn()
    const cancel = setWindowTimeout(win, fn, 100)
    close()
    cancel()
    vi.advanceTimersByTime(200)
    expect(fn).not.toHaveBeenCalled()
  })
})

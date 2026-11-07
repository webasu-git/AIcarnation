import { describe, expect, it } from 'vitest'
import { EngineWarmup, type WarmupDeps } from './engineWarmup'

/** 時刻を進めるだけの偽物。upAt の時刻からエンジンが答え、state の知らせを返す */
function fakeDeps(opts: { upAt?: number; state?: (t: number) => string }) {
  let t = 0
  let probes = 0
  const deps: WarmupDeps = {
    isUp: async () => {
      probes++
      return opts.upAt !== undefined && t >= opts.upAt
    },
    state: async () => opts.state?.(t) ?? 'unknown',
    sleep: async (ms) => {
      t += ms
    },
    now: () => t,
  }
  return { deps, time: () => t, probes: () => probes }
}

const timing = { timeoutMs: 60_000, intervalMs: 1000, graceMs: 3000 }

describe('EngineWarmup（音声エンジンを話す前に起こす）', () => {
  it('起動するまで待ち、使えるようになったら true', async () => {
    const f = fakeDeps({ upAt: 20_000, state: () => 'starting' })
    const w = new EngineWarmup(f.deps, timing)
    expect(await w.warmUp('aivis')).toBe(true)
    expect(f.time()).toBe(20_000)
    expect(w.isReady('aivis')).toBe(true)
  })

  it('入っていないと知らせがあれば、待たずにあきらめる（起動を頼んだ直後の古い知らせは信じない）', async () => {
    const f = fakeDeps({ state: () => 'missing' })
    const w = new EngineWarmup(f.deps, timing)
    expect(await w.warmUp('aivis')).toBe(false)
    expect(f.time()).toBe(3000)
  })

  it('起動を頼んだ直後に前の「止まった」が残っていても、起動中に変われば待つ', async () => {
    const f = fakeDeps({ upAt: 10_000, state: (t) => (t < 2000 ? 'stopped' : 'starting') })
    const w = new EngineWarmup(f.deps, timing)
    expect(await w.warmUp('aivis')).toBe(true)
  })

  it('時間内に起動しなければ false。次に呼ばれたときにまた試す', async () => {
    const f = fakeDeps({ state: () => 'starting' })
    const w = new EngineWarmup(f.deps, timing)
    expect(await w.warmUp('aivis')).toBe(false)
    expect(f.time()).toBe(60_000)
    const before = f.probes()
    await w.warmUp('aivis')
    expect(f.probes()).toBeGreaterThan(before)
  })

  it('待っている間に何度呼ばれても、確かめるのは1本だけ', async () => {
    const f = fakeDeps({ upAt: 5000 })
    const w = new EngineWarmup(f.deps, timing)
    const [a, b] = await Promise.all([w.warmUp('aivis'), w.warmUp('aivis')])
    expect(a && b).toBe(true)
    expect(f.probes()).toBe(6)
  })
})

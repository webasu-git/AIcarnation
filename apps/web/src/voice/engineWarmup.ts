import type { EngineId } from './engines'

/**
 * ローカル音声エンジンを、話す前に起こしておく。
 * エンジンは最初につながらなかったときに起動を頼む作りなので、何もしないと最初の一言はブラウザの声になってしまう。
 * 画面を開いたときに起こし始め、起動を待ってから話す。入っていない・止まったと知らせがあれば、待たずにあきらめる
 */

export interface WarmupDeps {
  /** エンジンが答えるか（つながらなければ、同梱サーバーが起動を頼む） */
  isUp(engine: EngineId): Promise<boolean>
  /** 起動の様子の知らせ（unknown / starting / missing / stopped） */
  state(engine: EngineId): Promise<string>
  sleep(ms: number): Promise<void>
  now(): number
  /** 起動を待ち始めた・使えるようになった・使えなかったときの知らせ（画面に出す） */
  onChange?(engine: EngineId, state: EngineStatus): void
}

/** エンジンの様子（unknown はまだ確かめていない） */
export type EngineStatus = 'unknown' | 'warming' | 'ready' | 'down'

export interface WarmupTiming {
  /** これより長く起動を待たない */
  timeoutMs: number
  /** 確かめる間隔 */
  intervalMs: number
  /** 起動を頼んだ直後は前の知らせ（止まった等）が残っているので、この間は「入っていない・止まった」を信じない */
  graceMs: number
}

export const DEFAULT_WARMUP_TIMING: WarmupTiming = { timeoutMs: 120_000, intervalMs: 1500, graceMs: 4000 }

export class EngineWarmup {
  private readonly ready = new Set<EngineId>()
  private readonly pending = new Map<EngineId, Promise<boolean>>()

  constructor(
    private readonly deps: WarmupDeps,
    private readonly timing: WarmupTiming = DEFAULT_WARMUP_TIMING,
  ) {}

  isReady(engine: EngineId): boolean {
    return this.ready.has(engine)
  }

  /** 起動を待っている最中か */
  isWarming(engine: EngineId): boolean {
    return this.pending.has(engine)
  }

  /** エンジンが使えるようになるまで待つ。使えれば true。待っている間に呼ばれたら同じ待ちを返す。使えなかったら、次に呼ばれたときにまた試す */
  warmUp(engine: EngineId): Promise<boolean> {
    if (this.ready.has(engine)) return Promise.resolve(true)
    const running = this.pending.get(engine)
    if (running) return running
    this.deps.onChange?.(engine, 'warming')
    const task = this.run(engine)
      .then((ok) => {
        this.deps.onChange?.(engine, ok ? 'ready' : 'down')
        return ok
      })
      .finally(() => this.pending.delete(engine))
    this.pending.set(engine, task)
    return task
  }

  /** 使えなくなった（合成に失敗した）。次は起こし直す */
  markDown(engine: EngineId): void {
    this.ready.delete(engine)
    this.deps.onChange?.(engine, 'down')
  }

  private async run(engine: EngineId): Promise<boolean> {
    const startedAt = this.deps.now()
    for (;;) {
      if (await this.deps.isUp(engine).catch(() => false)) {
        this.ready.add(engine)
        return true
      }
      const elapsed = this.deps.now() - startedAt
      if (elapsed >= this.timing.timeoutMs) return false
      if (elapsed >= this.timing.graceMs) {
        const state = await this.deps.state(engine).catch(() => 'unknown')
        if (state === 'missing' || state === 'stopped') return false
      }
      await this.deps.sleep(this.timing.intervalMs)
    }
  }
}

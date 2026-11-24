/**
 * 同梱サーバーへの問い合わせのやり直し。サーバーの入れ替え（プラグインの更新など）の間は数秒つながらないので、
 * すぐにやり直さず、少しずつ間を空けて試す（合わせて約 5 秒）
 */
export const retryTiming = {
  /** やり直す前に待つ時間（ミリ秒）。この数だけやり直す */
  delays: [500, 1500, 3000],
  /** やり直しても保存できなかったものを、あとで保存し直すまでの間隔 */
  resaveLater: 10_000,
  /** 保存し直しの間隔の上限 */
  resaveLaterMax: 300_000,
}

/** あとで保存し直すまでの間隔。失敗が続くほど倍にし、5 分で止める（保存先が止まったままのとき、試し続けないように） */
export function laterDelay(failures: number): number {
  return Math.min(retryTiming.resaveLater * 2 ** failures, retryTiming.resaveLaterMax)
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** fn が失敗したら、間を空けてやり直す。stillWanted が false を返したら（新しい依頼が来たなど）やめて undefined を返す */
export async function withRetry<T>(fn: () => Promise<T>, stillWanted: () => boolean = () => true): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const delay = retryTiming.delays[attempt]
      if (delay === undefined) throw err
      await sleep(delay)
      if (!stillWanted()) return undefined
    }
  }
}

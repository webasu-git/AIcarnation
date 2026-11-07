/**
 * なめらかに変わる乱数（1 次元のバリューノイズ）。
 * sin の揺れは周期が一定で「同じ動きの繰り返し」に見えるので、待機の揺れはこれで作る。
 * 種（seed）ごとに別の揺れになる。値はおよそ -1〜1
 */
export class Noise1D {
  private readonly values: Float32Array

  constructor(seed: number, size = 256) {
    this.values = new Float32Array(size)
    // 種から決まる簡単な乱数（同じ種なら毎回同じ揺れ）
    let s = (seed * 2654435761) >>> 0 || 1
    for (let i = 0; i < size; i++) {
      s = (s * 1664525 + 1013904223) >>> 0
      this.values[i] = (s / 0xffffffff) * 2 - 1
    }
  }

  /** 時刻 t（単位は「1 で 1 つの山」）の値 */
  at(t: number): number {
    const size = this.values.length
    const i = Math.floor(t)
    const f = t - i
    const a = this.values[((i % size) + size) % size] ?? 0
    const b = this.values[(((i + 1) % size) + size) % size] ?? 0
    const smooth = f * f * (3 - 2 * f)
    return a + (b - a) * smooth
  }

  /** ゆっくりした揺れに細かい揺れを少し混ぜたもの（自然な揺らぎ） */
  wobble(t: number): number {
    return this.at(t) * 0.75 + this.at(t * 2.7 + 31.7) * 0.25
  }
}

import { describe, expect, it } from 'vitest'
import { lightColor, paletteFromPixels } from './stageLighting'

/** 上半分が青、下半分が緑の 4×4 の画像 */
function skyAndGrass(): number[] {
  const data: number[] = []
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) data.push(...(y < 2 ? [40, 120, 230, 255] : [60, 170, 60, 255]))
  return data
}

describe('paletteFromPixels（背景の上のほう・下のほうの色）', () => {
  it('上のほうを空、下のほうを地面として平均する', () => {
    const p = paletteFromPixels(skyAndGrass(), 4, 4)
    expect(p.sky.map((v) => Math.round(v * 255))).toEqual([40, 120, 230])
    expect(p.ground.map((v) => Math.round(v * 255))).toEqual([60, 170, 60])
  })

  it('透明な画素は数えない。すべて透明なら白', () => {
    const data = skyAndGrass()
    for (let i = 3; i < data.length; i += 4) data[i] = 0
    expect(paletteFromPixels(data, 4, 4)).toEqual({ sky: [1, 1, 1], ground: [1, 1, 1] })
  })
})

describe('lightColor（背景の色を光の色にする）', () => {
  it('色味だけを借り、明るさはそろえ、鮮やかさは控えめにする', () => {
    const hsl = { h: 0, s: 0, l: 0 }
    lightColor([0, 0, 1], 0.7).getHSL(hsl)
    expect(hsl.l).toBeCloseTo(0.7, 2)
    expect(hsl.s).toBeLessThanOrEqual(0.551)
    expect(hsl.h).toBeCloseTo(2 / 3, 2)
    // 真っ黒な背景でも、光は暗くならない
    lightColor([0, 0, 0], 0.7).getHSL(hsl)
    expect(hsl.l).toBeCloseTo(0.7, 2)
  })
})

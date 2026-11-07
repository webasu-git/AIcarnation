import { describe, expect, it } from 'vitest'
import { iconLayout } from './iconLayout'

describe('iconLayout（丸いアイコンへの画像の置き方）', () => {
  it('拡大 1・真ん中なら、短い辺が丸の直径になり、画像の真ん中が丸の真ん中に来る', () => {
    // 横長 200×100 の画像を直径 50 の丸へ：短い辺（縦 100）が 50 になる
    const l = iconLayout(200, 100, 50, { x: 0.5, y: 0.5, zoom: 1 })
    expect(l.width).toBe(100)
    expect(l.height).toBe(50)
    expect(l.left).toBe(-25)
    expect(l.top).toBe(0)
  })

  it('端へ寄せすぎても、丸にすき間ができる手前で止まる', () => {
    const l = iconLayout(200, 100, 50, { x: 0, y: 0, zoom: 1 })
    expect(l.left).toBe(0)
    expect(l.top).toBe(0)
    // 止まった位置に合わせて、真ん中の位置も直す
    expect(l.view.x).toBeCloseTo(0.25)
    expect(l.view.y).toBeCloseTo(0.5)
  })

  it('拡大すると、選んだ位置を真ん中にしたまま大きくなる', () => {
    const l = iconLayout(100, 100, 50, { x: 0.3, y: 0.6, zoom: 2 })
    expect(l.width).toBe(100)
    expect(l.left).toBeCloseTo(25 - 30)
    expect(l.top).toBeCloseTo(25 - 60)
  })

  it('拡大は 1〜4 に収める', () => {
    expect(iconLayout(100, 100, 50, { x: 0.5, y: 0.5, zoom: 0.2 }).view.zoom).toBe(1)
    expect(iconLayout(100, 100, 50, { x: 0.5, y: 0.5, zoom: 9 }).view.zoom).toBe(4)
  })
})

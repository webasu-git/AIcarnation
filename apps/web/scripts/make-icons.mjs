// アプリのロゴ（logo.svg）とタブのアイコン（favicon）を作る。画像ライブラリを増やさないよう、SVG と PNG を自前で書き出す。
// 使い方：node apps/web/scripts/make-icons.mjs
//
// ロゴ「円を越える指先」：紺の地に、金のボーン（骨組み）だけで組んだアラベスクの踊り手。
// まわりの二重の円が、伸ばした手足の先で途切れる。AI が骨組みから体を得て、枠の外へ踏み出す瞬間
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const outDir = fileURLToPath(new URL('../public/icons/', import.meta.url))
mkdirSync(outDir, { recursive: true })

// --- 形（64×64 の座標） ---
const NAVY = '#1e1b4b'
const GOLD = '#e9c46a'
const GOLD_LIGHT = '#f4d58d'

/** 関節の位置（右上を向いたアラベスク） */
const J = {
  head: [39.4, 11.6], neck: [38.4, 15.2], chest: [36, 19],
  frontElbow: [25.5, 12.6], frontHand: [14.5, 12.4], backElbow: [45.5, 23], backHand: [54.5, 29],
  hips: [32.2, 31], knee: [31.4, 45], toe: [31.6, 58], backKnee: [44.6, 34.6], backToe: [57.2, 37.8],
}
/** 骨（根元, 先, 不透明度）。奥の腕と脚は薄くする */
const BONES = [
  ['neck', 'chest', 1], ['chest', 'frontElbow', 1], ['frontElbow', 'frontHand', 1],
  ['chest', 'backElbow', 0.6], ['backElbow', 'backHand', 0.6], ['chest', 'hips', 1],
  ['hips', 'knee', 1], ['knee', 'toe', 1], ['hips', 'backKnee', 0.6], ['backKnee', 'backToe', 0.6],
]
/** ボーン（ひし形）の4つの角。根元から 2 割のところがいちばん太い */
function boneQuad([hx, hy], [tx, ty]) {
  const dx = tx - hx, dy = ty - hy
  const len = Math.hypot(dx, dy)
  const ux = dx / len, uy = dy / len
  const w = Math.min(len * 0.12, 3.4)
  const px = hx + ux * len * 0.2, py = hy + uy * len * 0.2
  return [[hx, hy], [px - uy * w, py + ux * w], [tx, ty], [px + uy * w, py - ux * w]]
}
/** 二重の円（中心, 半径, 線の太さ, 不透明度, 描く角度の範囲[度]）。手足が抜けるところで途切れる */
const RING_CENTER = [33, 33]
const RINGS = [
  { r: 26, width: 1, opacity: 0.7, ranges: [[14.5, 270], [-43.5, 1.3]] },
  { r: 23.6, width: 0.6, opacity: 0.45, ranges: [[14.7, 270]] },
]
/** チュチュ（傾けた楕円の線） */
const TUTU = { cx: 31.6, cy: 32.4, rx: 13.5, ry: 3.4, angle: -10, width: 1.3, opacity: 0.85 }
const HEAD_R = 3.2

// --- SVG ---
const f = (n) => +n.toFixed(2)
function arcPath(r, from, to) {
  const [cx, cy] = RING_CENTER
  const p = (deg) => [f(cx + r * Math.cos((deg * Math.PI) / 180)), f(cy + r * Math.sin((deg * Math.PI) / 180))]
  const [x0, y0] = p(from), [x1, y1] = p(to)
  return `M${x0} ${y0}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`
}
function svg() {
  const parts = [`<rect width="64" height="64" rx="16" fill="${NAVY}"/>`]
  for (const ring of RINGS)
    for (const [a, b] of ring.ranges)
      parts.push(`<path d="${arcPath(ring.r, a, b)}" fill="none" stroke="${GOLD}" stroke-width="${ring.width}" opacity="${ring.opacity}"/>`)
  for (const [a, b, o] of BONES) {
    const q = boneQuad(J[a], J[b]).map(([x, y]) => `${f(x)} ${f(y)}`)
    parts.push(`<path d="M${q.join('L')}Z" fill="${GOLD}"${o < 1 ? ` opacity="${o}"` : ''}/>`)
  }
  const t = TUTU
  parts.push(`<ellipse cx="${t.cx}" cy="${t.cy}" rx="${t.rx}" ry="${t.ry}" transform="rotate(${t.angle} ${t.cx} ${t.cy})" fill="none" stroke="${GOLD}" stroke-width="${t.width}" opacity="${t.opacity}"/>`)
  parts.push(`<circle cx="${J.head[0]}" cy="${J.head[1]}" r="${HEAD_R}" fill="${GOLD_LIGHT}"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${parts.join('')}</svg>\n`
}

// --- PNG 書き出し ---
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- 描画（1 画素を 4×4 に分けて形に入っているかを数える） ---
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const inRoundedRect = (x, y) => {
  const qx = Math.abs(x - 32) - 32 + 16, qy = Math.abs(y - 32) - 32 + 16
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 16 <= 0
}
const inQuad = (x, y, q) => {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4]
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
    if (cross !== 0) {
      if (sign === 0) sign = Math.sign(cross)
      else if (Math.sign(cross) !== sign) return false
    }
  }
  return true
}
const onRing = (x, y, ring) => {
  const dx = x - RING_CENTER[0], dy = y - RING_CENTER[1]
  if (Math.abs(Math.hypot(dx, dy) - ring.r) > ring.width / 2) return false
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI
  return ring.ranges.some(([a, b]) => [deg, deg + 360, deg - 360].some((d) => d >= a && d <= b))
}
const onTutu = (x, y) => {
  const t = TUTU, a = (-t.angle * Math.PI) / 180
  const lx = (x - t.cx) * Math.cos(a) - (y - t.cy) * Math.sin(a)
  const ly = (x - t.cx) * Math.sin(a) + (y - t.cy) * Math.cos(a)
  const s = Math.hypot(lx / t.rx, ly / t.ry)
  const grad = Math.hypot(lx / (t.rx * t.rx * s), ly / (t.ry * t.ry * s))
  return Math.abs((s - 1) / grad) <= t.width / 2
}
const quads = BONES.map(([a, b, o]) => ({ q: boneQuad(J[a], J[b]), o }))

function draw(size) {
  const N = 4
  const navy = rgb(NAVY), gold = rgb(GOLD), goldLight = rgb(GOLD_LIGHT)
  const buf = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0]
      let alpha = 0
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const x = ((px + (sx + 0.5) / N) / size) * 64
          const y = ((py + (sy + 0.5) / N) / size) * 64
          if (!inRoundedRect(x, y)) continue
          // 下から順に重ねる：地 → 円 → 骨 → チュチュ → 頭
          let c = navy
          const over = (col, o) => { c = c.map((v, i) => v + (col[i] - v) * o) }
          for (const ring of RINGS) if (onRing(x, y, ring)) over(gold, ring.opacity)
          for (const { q, o } of quads) if (inQuad(x, y, q)) over(gold, o)
          if (onTutu(x, y)) over(gold, TUTU.opacity)
          if (Math.hypot(x - J.head[0], y - J.head[1]) <= HEAD_R) over(goldLight, 1)
          sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2]
          alpha++
        }
      }
      const o = (py * size + px) * 4
      if (alpha > 0) for (let i = 0; i < 3; i++) buf[o + i] = Math.round(sum[i] / alpha)
      buf[o + 3] = Math.round((alpha / (N * N)) * 255)
    }
  }
  return png(size, buf)
}

writeFileSync(outDir + 'logo.svg', svg())
console.log('wrote logo.svg')
for (const size of [16, 32, 180]) {
  writeFileSync(outDir + `favicon-${size}.png`, draw(size))
  console.log(`wrote favicon-${size}.png`)
}

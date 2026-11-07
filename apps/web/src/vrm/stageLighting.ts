import * as THREE from 'three'

/** 背景から読み取った光の色（sRGB、0〜1）。空（上のほう）と地面（下のほう） */
export interface BackdropPalette {
  sky: [number, number, number]
  ground: [number, number, number]
}

/** 何も読み取っていないときの光（白） */
export const NEUTRAL_PALETTE: BackdropPalette = { sky: [1, 1, 1], ground: [1, 1, 1] }

/** 上から何割を空、下から何割を地面として平均するか */
const BAND = 0.35

/**
 * 画像の画素（RGBA の並び）から、上のほう・下のほうの平均の色を出す。透明な画素は数えない。
 * どんな画像でも同じやり方で読むので、特定の背景に合わせた値は持たない
 */
export function paletteFromPixels(data: ArrayLike<number>, width: number, height: number): BackdropPalette {
  const band = Math.max(1, Math.round(height * BAND))
  const average = (fromRow: number, toRow: number): [number, number, number] => {
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let y = fromRow; y < toRow; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const a = (data[i + 3] ?? 0) / 255
        if (a === 0) continue
        r += (data[i] ?? 0) * a
        g += (data[i + 1] ?? 0) * a
        b += (data[i + 2] ?? 0) * a
        n += a
      }
    }
    return n === 0 ? [1, 1, 1] : [r / n / 255, g / n / 255, b / n / 255]
  }
  return { sky: average(0, band), ground: average(height - band, height) }
}

/**
 * 背景の色を、アバターに当てる光の色にする。色味（色相）だけを借り、鮮やかさは控えめに、明るさはそろえる。
 * 暗い背景でもアバターが真っ暗にならず、派手な背景でも色が付きすぎないようにするため
 */
export function lightColor(rgb: readonly [number, number, number], lightness: number, maxSaturation = 0.55): THREE.Color {
  const color = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)
  const hsl = { h: 0, s: 0, l: 0 }
  color.getHSL(hsl)
  return new THREE.Color().setHSL(hsl.h, Math.min(hsl.s, maxSaturation), lightness)
}

/**
 * アバターに当てる光。正面上からの光（今までの白い光）に、背景の空の色を上から・地面の色を下から当てる光を足す。
 * strength（0〜1）で、背景に合わせる強さを決める（0 で今までどおりの白い光だけ）。足したぶん正面の光を弱め、明るさはおおむね保つ
 */
export class StageLighting {
  private readonly hemisphere = new THREE.HemisphereLight(0xffffff, 0xffffff, 0)
  private palette: BackdropPalette = NEUTRAL_PALETTE
  private strength = 0.5

  constructor(
    scene: THREE.Scene,
    private readonly key: THREE.DirectionalLight,
    private readonly keyIntensity: number,
  ) {
    scene.add(this.hemisphere)
    this.apply()
  }

  setPalette(palette: BackdropPalette): void {
    this.palette = palette
    this.apply()
  }

  setStrength(strength: number): void {
    this.strength = strength
    this.apply()
  }

  private apply(): void {
    const s = this.strength
    const sky = lightColor(this.palette.sky, 0.72, 0.5)
    this.hemisphere.color.copy(sky)
    // 地面からの照り返しは顔や体の下側に強く乗るので、色は薄めにする（緑の草地で肌が緑に見えないように）
    this.hemisphere.groundColor.copy(lightColor(this.palette.ground, 0.55, 0.3))
    this.hemisphere.intensity = 2.6 * s
    this.key.color.set(0xffffff).lerp(sky, 0.6 * s)
    this.key.intensity = this.keyIntensity * (1 - 0.15 * s)
  }
}

/** アイコンにできる画像（jpg・png・webp・gif・avif） */
export const ICON_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/avif'
export const ICON_MAX_ZOOM = 4

export function isIconImage(file: File): boolean {
  return /^image\/(jpeg|png|webp|gif|avif)$/.test(file.type) || /\.(jpe?g|png|webp|gif|avif)$/i.test(file.name)
}

export interface IconView {
  /** 丸の真ん中に置く画像の位置（0〜1） */
  x: number
  y: number
  /** 1 で丸がちょうど画像で埋まる */
  zoom: number
}

export interface IconLayout {
  /** 丸の中に置く画像の大きさと位置（丸の左上から、px） */
  width: number
  height: number
  left: number
  top: number
  /** はみ出しを抑えたあとの見え方（丸にすき間ができないよう、端へ寄せすぎた分を戻したもの） */
  view: IconView
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * 直径 size の丸に、画像（imageWidth × imageHeight）をどう置くか。
 * 拡大 1 で丸がちょうど画像で埋まり（短い辺が丸の直径）、画像の (x, y) が丸の真ん中に来る。
 * 丸にすき間ができるほど端へ寄せたときは、すき間が無くなる位置まで戻す
 */
export function iconLayout(imageWidth: number, imageHeight: number, size: number, view: IconView): IconLayout {
  const zoom = clamp(view.zoom, 1, ICON_MAX_ZOOM)
  const scale = Math.max(size / imageWidth, size / imageHeight) * zoom
  const width = imageWidth * scale
  const height = imageHeight * scale
  const left = clamp(size / 2 - view.x * width, size - width, 0)
  const top = clamp(size / 2 - view.y * height, size - height, 0)
  return { width, height, left, top, view: { x: (size / 2 - left) / width, y: (size / 2 - top) / height, zoom } }
}

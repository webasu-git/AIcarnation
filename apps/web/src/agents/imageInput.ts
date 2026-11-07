import { MAX_AGENT_IMAGE_BYTES, base64ByteLength, type AgentImage } from '@aicarnation/shared'

/** Claude の画像入力で効率がよい長辺の上限。これより大きいと送信量だけ増える */
const MAX_SIDE = 1568

export interface PickedImage {
  /** 一覧に出す縮小済み画像（data URL） */
  preview: string
  image: AgentImage
}

/**
 * 選んだ画像を長辺 1568px 以下の JPEG にして base64 にする。
 * 5MB を超える場合は画質を下げてやり直す。画像は生成にだけ使い、保存しない
 */
export async function toAgentImage(file: File): Promise<PickedImage> {
  if (!file.type.startsWith('image/')) throw new Error('画像ファイルをお選びください')
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('画像を読み込めませんでした')
  // 透過部分が黒くならないよう白で塗ってから描く
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  for (const quality of [0.85, 0.7, 0.5]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1)
    if (base64ByteLength(data) <= MAX_AGENT_IMAGE_BYTES) {
      return { preview: dataUrl, image: { mediaType: 'image/jpeg', data } }
    }
  }
  throw new Error('画像が大きすぎます')
}

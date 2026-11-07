import { getVrmFile } from '../db/vrmFiles'

/**
 * アイコンの画像を、保存したファイルから読んで表示用の URL と大きさにする。
 * 一覧で何度も描くので、ファイルごとに一度だけ読む（画像は小さく、数も少ないので解放はしない）
 */
export interface LoadedIconImage {
  url: string
  width: number
  height: number
}

const cache = new Map<string, Promise<LoadedIconImage | null>>()

export function measureImage(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = url
  })
}

export function loadIconImage(fileId: string): Promise<LoadedIconImage | null> {
  let pending = cache.get(fileId)
  if (!pending) {
    pending = (async () => {
      const record = await getVrmFile(fileId).catch(() => undefined)
      if (!record) return null
      const url = URL.createObjectURL(record.blob)
      const size = await measureImage(url)
      return size ? { url, ...size } : null
    })()
    cache.set(fileId, pending)
  }
  return pending
}

/** データが FBX か（バイナリ版とテキスト版のどちらも）。FBX の読み込み部品は大きいので、見分けるだけの関数を分けておく */
export function isFbx(data: ArrayBuffer): boolean {
  const head = new TextDecoder('latin1').decode(new Uint8Array(data, 0, Math.min(data.byteLength, 256)))
  return head.startsWith('Kaydara FBX Binary') || /FBXHeaderExtension|; FBX \d/.test(head)
}

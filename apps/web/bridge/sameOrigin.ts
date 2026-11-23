/**
 * 開発サーバーの中継（/api・/tts/aivis）を、ほかのサイトから使わせないための確認。
 * 中継は Origin を外して流すので、中継先（音声エンジンなど）は送り元を見分けられない。ここで断らないと、
 * 開発サーバーを動かしたまま悪意のあるページを開いたときに、そのページから手元の音声エンジンを操作される
 * （読みの辞書の書き換え・声のモデルの追加など）
 */

/** リクエストの見出しから、ほかのサイトからの呼び出しかを見分ける。port は開発サーバーのポート */
export function isCrossSite(headers: Record<string, string | string[] | undefined>, port: number): boolean {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  // ブラウザが付ける見出し：ほかのサイトからなら cross-site（画像の読み込みや no-cors の GET のように、Origin が付かないものも分かる）
  if (one(headers['sec-fetch-site']) === 'cross-site') return true
  // Origin が付いていれば、この開発サーバーのものだけを通す（付かないのは、同じオリジンの GET か、ブラウザ以外）
  const origin = one(headers.origin)
  return origin !== undefined && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`
}

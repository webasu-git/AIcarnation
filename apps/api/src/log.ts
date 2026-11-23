/**
 * ログに出す利用者の印。匿名 ID はそれだけで本人になりすませる（唯一の認証情報）ので、ログにはそのまま出さない。
 * ハッシュの先頭だけを出す：同じ利用者の記録どうしは結び付けられるが、ログを読める人が ID を取り出すことはできない
 */
export async function logId(anonId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(anonId))
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

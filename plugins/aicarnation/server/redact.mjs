// 秘密の文字列らしきものを伏せ字にする（API キー・トークン・長いランダムな英数字）。
// 会話の記録をファイルに書くときと、逆提案の材料をモデルに渡すときに使う。
// 取りこぼしより消しすぎを選ぶ（記録や材料は「何の話をしていたか」が分かれば足りる）

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // API キー（sk-…、sk-ant-…）
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g, // Slack
  /\bxapp-[A-Za-z0-9-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
]
/** 「token=…」「password: …」のような、名前の後ろの値（間の空白は少しだけ許す。長い空白の並びで遅くならないように） */
const NAMED_SECRET = /\b((?:api[_-]?key|token|secret|password|passwd|authorization|bearer)[ \t]{0,3}[=:]?[ \t]{0,3})(["']?)[^\s"'&,;]{6,}\2/gi
/** 長いランダムな英数字（32 文字以上で、数字と英字の両方を含む） */
const LONG_RANDOM = /\b[A-Za-z0-9_-]{32,}\b/g

export function redact(text) {
  let out = String(text)
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]')
  out = out.replace(NAMED_SECRET, (_, name) => `${name}[REDACTED]`)
  return out.replace(LONG_RANDOM, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '[REDACTED]' : m))
}

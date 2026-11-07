/**
 * 画面の色のテーマ。ブラウザ（OS）の設定に合わせる「システム」か、いつも明るい「ライト」、いつも暗い「ダーク」。
 * 決まった色は <html data-theme="light|dark"> にして、style.css の色をそれに合わせる。小窓（Document PiP）の画面にも同じものを当てる。
 * 選んだテーマは設定（settings ストア）に保存する。読み込みを待つ間に色がちらつかないよう、この端末にも控えておく
 */
export type ThemeChoice = 'system' | 'light' | 'dark'

const CACHE_KEY = 'aicarnation:theme'
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const documents = new Set<Document>([document])

function cachedChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(CACHE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

let choice: ThemeChoice = cachedChoice()

/** 今の画面が明るいか暗いか */
export function resolvedTheme(): 'light' | 'dark' {
  if (choice === 'system') return darkQuery.matches ? 'dark' : 'light'
  return choice
}

function paint(): void {
  const theme = resolvedTheme()
  for (const doc of documents) doc.documentElement.dataset.theme = theme
}

/** テーマを替える（設定から呼ぶ） */
export function setTheme(next: ThemeChoice): void {
  choice = next
  try {
    localStorage.setItem(CACHE_KEY, next)
  } catch {
    // 控えられなくても、設定には保存される
  }
  paint()
}

/** 読み込みを待つ間に使う、この端末に控えたテーマ */
export function initialTheme(): ThemeChoice {
  return choice
}

/** 小窓の画面にも同じテーマを当てる。戻り値は、小窓を閉じたときに呼ぶ後始末 */
export function followTheme(doc: Document): () => void {
  documents.add(doc)
  paint()
  return () => documents.delete(doc)
}

// 「システム」の間は、ブラウザ（OS）の明るさの切り替えにそのまま付いていく
darkQuery.addEventListener('change', () => {
  if (choice === 'system') paint()
})
paint()

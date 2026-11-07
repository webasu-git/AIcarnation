import type { Directive } from 'vue'

/**
 * 設定のカードを、見出しを押してたためるようにする（v-collapsible="'カードの名前'"）。
 * 右上に小さな矢印を置き、見出しの行（ボタンや入力欄以外）か矢印を押すとたたむ・開く。
 * たたんだカードはこの端末に覚える（この端末だけの便利のため。読めなければすべて開いたまま）
 */
const KEY = 'aicarnation:collapsed-cards'

function loadCollapsed(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveCollapsed(ids: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]))
  } catch {
    // 覚えられなくても、たたむ・開くはそのまま使える
  }
}

const CHEVRON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'

/** 押しても、たたむ・開くにしない部品（見出しの中のボタンや入力欄） */
const INTERACTIVE = 'button, a, input, select, textarea, label'

export const vCollapsible: Directive<HTMLElement, string> = {
  mounted(el, { value: id }) {
    const heading = el.querySelector('h2')
    if (!heading) return
    // 見出しが行の中にあるカード（キャラクターの一覧など）は、その行ごとを見出しとして扱う
    const head = heading.parentElement && heading.parentElement !== el ? heading.parentElement : heading
    el.classList.add('collapsible')
    head.classList.add('collapsible-head')

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'collapse-toggle'
    toggle.innerHTML = CHEVRON
    el.appendChild(toggle)

    const apply = (collapsed: boolean) => {
      el.classList.toggle('collapsed', collapsed)
      toggle.setAttribute('aria-expanded', String(!collapsed))
      toggle.title = collapsed ? '開く' : 'たたむ'
      toggle.setAttribute('aria-label', toggle.title)
    }
    const flip = () => {
      const collapsed = !el.classList.contains('collapsed')
      const ids = loadCollapsed()
      if (collapsed) ids.add(id)
      else ids.delete(id)
      saveCollapsed(ids)
      apply(collapsed)
    }
    apply(loadCollapsed().has(id))
    toggle.addEventListener('click', flip)
    head.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest(INTERACTIVE)) return
      flip()
    })
  },
}

declare module 'vue' {
  interface GlobalDirectives {
    vCollapsible: typeof vCollapsible
  }
}

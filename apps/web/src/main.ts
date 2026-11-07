import { createApp } from 'vue'
import { vCollapsible } from './components/ui/collapsible'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
// 画面を描く前に、明るい・暗いを決めておく（色がちらつかないように）
import './theme'

/**
 * あとから読み込む部品（編集画面など）が読めなかったら、画面を開き直す。
 * 同梱版は画面を作り直すと古い部品のファイルが消えるので、前から開いていた画面はボタンを押しても何も起きなくなるため。
 * 開き直しを繰り返さないよう、30 秒に1回まで
 */
const RELOAD_KEY = 'aicarnation:reloaded-for-update'
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last < 30_000) return
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    return
  }
  event.preventDefault()
  location.reload()
})

createApp(App).use(createPinia()).directive('collapsible', vCollapsible).mount('#app')

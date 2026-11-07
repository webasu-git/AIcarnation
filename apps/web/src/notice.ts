import { ref } from 'vue'

/**
 * 小窓の下のバーに少しの間だけ出す知らせ（音量・吹き出し・読み上げを切り替えたときなど）。
 * 知らせが無いときは、バーには声の様子を出す
 */
export const barNotice = ref('')

const NOTICE_MS = 2500
let timer: ReturnType<typeof setTimeout> | undefined

export function notify(text: string, ms = NOTICE_MS): void {
  barNotice.value = text
  clearTimeout(timer)
  timer = setTimeout(() => (barNotice.value = ''), ms)
}

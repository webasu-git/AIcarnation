import { ref } from 'vue'

/** 「はじめに」の案内を閉じたか。この端末に覚え、「設定」タブからもう一度出せる */
const DISMISS_KEY = 'aicarnation:setup-guide-closed'

function wasClosed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export const setupGuideClosed = ref(wasClosed())

export function setSetupGuideClosed(closed: boolean): void {
  setupGuideClosed.value = closed
  try {
    if (closed) localStorage.setItem(DISMISS_KEY, '1')
    else localStorage.removeItem(DISMISS_KEY)
  } catch {
    // 覚えられなくても困らない
  }
}

/** 準備が終わったあと、1行に縮めた案内を開いて手順まで見せているか（「設定」タブの「案内を見る」でも開く） */
export const setupGuideExpanded = ref(false)

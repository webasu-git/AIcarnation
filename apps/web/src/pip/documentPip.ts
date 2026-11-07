import { followTheme } from '../theme'

export const PIP_WIDTH = 420
export const PIP_HEIGHT = 660

export function isDocumentPipSupported(): boolean {
  return window.documentPictureInPicture != null
}

/** 本体のスタイルを小窓へ写す。CSSOM を読めない外部スタイルシートは link で読み直す */
function copyStyles(target: Document): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement('style')
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n')
      target.head.appendChild(style)
    } catch {
      if (!sheet.href) continue
      const link = target.createElement('link')
      link.rel = 'stylesheet'
      link.href = sheet.href
      target.head.appendChild(link)
    }
  }
}

export interface DocumentPipSession {
  window: Window
  close(): void
}

/**
 * element を Document PiP の小窓へ移す。小窓が閉じられたら元の位置へ戻し、onClose を呼ぶ。
 * ユーザー操作（クリック）の中から呼ぶ必要がある。
 */
export async function openDocumentPip(
  element: HTMLElement,
  onClose: () => void,
): Promise<DocumentPipSession> {
  const api = window.documentPictureInPicture
  if (!api) throw new Error('Document Picture-in-Picture に対応していません')

  const pipWindow = await api.requestWindow({ width: PIP_WIDTH, height: PIP_HEIGHT })
  copyStyles(pipWindow.document)
  const unfollowTheme = followTheme(pipWindow.document)
  pipWindow.document.title = document.title
  pipWindow.document.body.classList.add('pip-body')

  const placeholder = document.createComment('pip-placeholder')
  element.replaceWith(placeholder)
  pipWindow.document.body.appendChild(element)

  pipWindow.addEventListener(
    'pagehide',
    () => {
      unfollowTheme()
      placeholder.replaceWith(element)
      onClose()
    },
    { once: true },
  )

  return { window: pipWindow, close: () => pipWindow.close() }
}

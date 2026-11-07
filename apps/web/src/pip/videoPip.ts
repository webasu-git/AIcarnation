const STREAM_FPS = 30

function isWebkitPipSupported(video: HTMLVideoElement): boolean {
  return video.webkitSupportsPresentationMode?.('picture-in-picture') === true
}

export function isVideoPipSupported(): boolean {
  if (!('captureStream' in HTMLCanvasElement.prototype)) return false
  if (document.pictureInPictureEnabled) return true
  return isWebkitPipSupported(document.createElement('video'))
}

export interface VideoPipSession {
  close(): void
}

/**
 * Document PiP が無いブラウザ向け。canvas を動画にして通常の動画PiPで表示する。
 * 入力は本体タブで行う前提。ユーザー操作の中から呼ぶ必要がある。
 */
export async function openVideoPip(
  canvas: HTMLCanvasElement,
  onClose: () => void,
): Promise<VideoPipSession> {
  const stream = canvas.captureStream(STREAM_FPS)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  // 画面外に置く。DOM に無いと PiP に入れないブラウザがある
  Object.assign(video.style, {
    position: 'fixed',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
    left: '-10px',
    top: '-10px',
  })
  document.body.appendChild(video)

  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    stream.getTracks().forEach((t) => t.stop())
    video.remove()
    onClose()
  }

  try {
    await video.play()
    if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
      video.addEventListener('leavepictureinpicture', cleanup, { once: true })
      await video.requestPictureInPicture()
      return {
        close: () => {
          if (document.pictureInPictureElement === video) void document.exitPictureInPicture()
          else cleanup()
        },
      }
    }
    if (isWebkitPipSupported(video) && video.webkitSetPresentationMode) {
      video.addEventListener('webkitpresentationmodechanged', () => {
        if (video.webkitPresentationMode !== 'picture-in-picture') cleanup()
      })
      video.webkitSetPresentationMode('picture-in-picture')
      return { close: () => video.webkitSetPresentationMode?.('inline') }
    }
    throw new Error('動画のピクチャーインピクチャーに対応していません')
  } catch (err) {
    cleanup()
    throw err
  }
}

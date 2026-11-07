import { onBeforeUnmount, ref, type Ref } from 'vue'
import type { VrmViewer } from '../vrm/viewer'
import { isDocumentPipSupported, openDocumentPip } from './documentPip'
import { isVideoPipSupported, openVideoPip } from './videoPip'
import { unlockAudio } from '../voice/audio'

export type PipSupport = 'document' | 'video' | 'none'
export type PipMode = 'none' | 'document' | 'video'

/** 小窓表示中の描画上限 */
const PIP_FPS = 30
const NORMAL_FPS = 60

function detectSupport(): PipSupport {
  if (isDocumentPipSupported()) return 'document'
  if (isVideoPipSupported()) return 'video'
  return 'none'
}

/**
 * 「小窓で開く」の制御。Document PiP があればステージごと小窓へ移し、
 * 無ければ canvas を動画PiPで表示する。
 */
export function usePip(stage: Ref<HTMLElement | null>, getViewer: () => VrmViewer | null) {
  const support = detectSupport()
  const mode = ref<PipMode>('none')
  const error = ref('')
  let close: (() => void) | null = null

  function onClosed() {
    const viewer = getViewer()
    if (viewer) {
      viewer.setMaxFps(NORMAL_FPS)
      viewer.setFrameSource('raf')
      viewer.rebind()
    }
    mode.value = 'none'
    close = null
  }

  async function open() {
    const viewer = getViewer()
    if (!viewer || !stage.value || mode.value !== 'none') return
    error.value = ''
    try {
      if (support === 'document') {
        const session = await openDocumentPip(stage.value, onClosed)
        close = session.close
        // 小窓の中の操作でも、音声エンジンの声の再生を許可する
        session.window.addEventListener('pointerdown', unlockAudio)
        session.window.addEventListener('keydown', unlockAudio)
        mode.value = 'document'
        viewer.setMaxFps(PIP_FPS)
        viewer.rebind()
      } else if (support === 'video') {
        viewer.setMaxFps(PIP_FPS)
        viewer.setFrameSource('worker')
        mode.value = 'video'
        const session = await openVideoPip(viewer.canvas, onClosed)
        close = session.close
      }
    } catch (err) {
      error.value = `小窓を開けませんでした：${err instanceof Error ? err.message : String(err)}`
      if (mode.value !== 'none') onClosed()
    }
  }

  function exit() {
    close?.()
  }

  onBeforeUnmount(exit)

  return { support, mode, error, open, exit }
}

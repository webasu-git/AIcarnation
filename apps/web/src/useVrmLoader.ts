import { ref } from 'vue'
import type { AgentVrmRef } from '@aicarnation/shared'
import type { VrmViewer } from './vrm/viewer'
import { getVrmFile, saveVrmFile } from './db/vrmFiles'

/**
 * エージェントの見た目（VRM）の読み込み。3D モデルは利用者が入れる（アプリには同梱しない）。
 * 読み込みが重なったときは最後に頼んだものだけを表示する。
 */
export function useVrmLoader(getViewer: () => VrmViewer | null) {
  const loading = ref(false)
  const error = ref('')
  /** 表示中のモデルの名前。入っていなければ空 */
  const current = ref('')
  /** 表示中のVRMの参照。同じものを読み直さないために使う */
  let loadedKey = ''
  let token = 0

  const keyOf = (vrm: AgentVrmRef) => `${vrm.source}:${vrm.ref}`

  async function run(key: string, label: string, source: () => Promise<ArrayBuffer>): Promise<boolean> {
    const viewer = getViewer()
    if (!viewer) return false
    const mine = ++token
    loading.value = true
    error.value = ''
    try {
      const data = await source()
      if (mine !== token) return false
      const info = await viewer.load(data)
      if (mine !== token) return false
      current.value = `${info.title || label}（${info.spec}）`
      loadedKey = key
      return true
    } catch (err) {
      if (mine === token) {
        error.value = `${label}を読み込めませんでした：${err instanceof Error ? err.message : String(err)}`
      }
      return false
    } finally {
      if (mine === token) loading.value = false
    }
  }

  /** 表示中のモデルを外す */
  function clear(key: string) {
    ++token
    getViewer()?.clear()
    current.value = ''
    loading.value = false
    loadedKey = key
  }

  /**
   * エージェントに設定されたVRMを表示する。まだ入れていない（以前の同梱サンプルを含む）・ファイルが見つからないときは、
   * 何も表示しない
   */
  async function loadRef(vrm: AgentVrmRef): Promise<void> {
    if (keyOf(vrm) === loadedKey) return
    if (vrm.source === 'local') {
      const record = await getVrmFile(vrm.ref)
      if (record) {
        await run(keyOf(vrm), record.name, () => record.blob.arrayBuffer())
        return
      }
      clear(keyOf(vrm))
      error.value = 'このキャラクターの VRM ファイルが見つかりません。お手数ですが、もう一度お選びください'
      return
    }
    clear(keyOf(vrm))
    error.value = ''
  }

  /** ローカルの .vrm を表示して保存し、エージェントに保存する参照を返す */
  async function pickFile(file: File): Promise<AgentVrmRef | null> {
    if (!file.name.toLowerCase().endsWith('.vrm')) {
      error.value = '.vrm ファイルをお選びください'
      return null
    }
    const ok = await run('', file.name, () => file.arrayBuffer())
    if (!ok) return null
    const vrm: AgentVrmRef = { source: 'local', ref: await saveVrmFile(file) }
    loadedKey = keyOf(vrm)
    return vrm
  }

  return { loading, error, current, loadRef, pickFile }
}

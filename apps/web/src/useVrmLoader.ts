import { ref } from 'vue'
import type { AgentVrmRef } from '@aicarnation/shared'
import type { VrmViewer } from './vrm/viewer'
import { getVrmFile, saveVrmFile } from './db/vrmFiles'

/**
 * エージェントの見た目（VRM）の読み込み。3D モデルは利用者が入れる（アプリには同梱しない）。
 * 読み込みが重なったときは最後に頼んだものだけを表示する（順番は頼んだ時点で決める。
 * ファイルが届いた順で決めると、大きくて遅いモデルが、あとから頼んだ小さいモデルを上書きしてしまう）。
 */
export function useVrmLoader(getViewer: () => VrmViewer | null) {
  const loading = ref(false)
  const error = ref('')
  /** 表示中のモデルの名前。入っていなければ空 */
  const current = ref('')
  /** 表示中のVRMの参照。同じものを読み直さないために使う */
  let loadedKey = ''
  /** 最後に頼まれたVRMの参照（読み込み中のものを含む）。同じものを続けて頼まれたら読み直さない */
  let requestedKey = ''
  let token = 0

  const keyOf = (vrm: AgentVrmRef) => `${vrm.source}:${vrm.ref}`

  /** mine は頼んだ順の番号（頼んだ時点で ++token して渡す）。途中でほかの読み込みが頼まれたら、表示せずにやめる */
  async function run(key: string, label: string, source: () => Promise<ArrayBuffer>, mine = ++token): Promise<boolean> {
    const viewer = getViewer()
    if (!viewer || mine !== token) return false
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
        // 失敗したものは、もう一度頼めるようにする
        requestedKey = loadedKey
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
    requestedKey = key
  }

  /**
   * エージェントに設定されたVRMを表示する。まだ入れていない（以前の同梱サンプルを含む）・ファイルが見つからないときは、
   * 何も表示しない
   */
  async function loadRef(vrm: AgentVrmRef): Promise<void> {
    const key = keyOf(vrm)
    if (key === requestedKey) return
    requestedKey = key
    // 頼んだ順の番号は、ファイルを取りに行く前に決める
    const mine = ++token
    if (vrm.source === 'local') {
      const record = await getVrmFile(vrm.ref)
      // 取りに行っている間に、ほかの見た目が頼まれた
      if (mine !== token) return
      if (record) {
        await run(key, record.name, () => record.blob.arrayBuffer(), mine)
        return
      }
      clear(key)
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
    requestedKey = loadedKey
    return vrm
  }

  return { loading, error, current, loadRef, pickFile }
}

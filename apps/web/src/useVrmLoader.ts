import { ref } from 'vue'
import type { AgentVrmRef } from '@aicarnation/shared'
import type { VrmViewer } from './vrm/viewer'
import { getVrmFile, saveVrmFile } from './db/vrmFiles'
import { withRetry } from './retry'

/**
 * エージェントの見た目（VRM）の読み込み。3D モデルは利用者が入れる（アプリには同梱しない）。
 * 読み込みが重なったときは最後に頼んだものだけを表示する（順番は頼んだ時点で決める。
 * ファイルが届いた順で決めると、大きくて遅いモデルが、あとから頼んだ小さいモデルを上書きしてしまう）。
 */
/** 選んだファイルを表示したが、保存できなかった。shownKey は、そのとき表示した参照 */
export class PickSaveError extends Error {
  constructor(
    readonly shownKey: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}

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
      let record: Awaited<ReturnType<typeof getVrmFile>>
      try {
        // 一時的に取りに行けないことがあるので、間を空けて取り直す（ほかの見た目が頼まれたらやめる）
        record = await withRetry(() => getVrmFile(vrm.ref), () => mine === token)
      } catch (err) {
        // 取りに行けなかった（保存先に一時的につながらないなど）。もう一度頼めるようにして知らせる
        if (mine === token) {
          requestedKey = loadedKey
          error.value = `VRM ファイルを読み込めませんでした：${err instanceof Error ? err.message : String(err)}`
        }
        return
      }
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

  let picks = 0

  /**
   * ローカルの .vrm を表示して保存し、エージェントに保存する参照を返す。
   * 選んだファイルは、保存するまで選ぶたびに違う参照（pick:番号）で表示する
   * （保存を待っている間に、ほかのキャラクターへ切り替えたら読み直させる。どの選んだファイルを表示しているかを区別する）
   */
  async function pickFile(file: File): Promise<AgentVrmRef | null> {
    if (!file.name.toLowerCase().endsWith('.vrm')) {
      error.value = '.vrm ファイルをお選びください'
      return null
    }
    const pickKey = `pick:${++picks}`
    requestedKey = pickKey
    const ok = await run(pickKey, file.name, () => file.arrayBuffer())
    if (!ok) return null
    // 表示した時点の番号（保存を待っている間にほかの見た目が頼まれたら、表示中の参照を書き換えない）
    const mine = token
    let ref: string
    try {
      ref = await saveVrmFile(file)
    } catch (err) {
      // 保存できなかった：呼び出し元が、表示しているものを確かめて前の見た目に戻す
      throw new PickSaveError(pickKey, err)
    }
    const vrm: AgentVrmRef = { source: 'local', ref }
    if (mine === token) {
      loadedKey = keyOf(vrm)
      requestedKey = loadedKey
    }
    return vrm
  }

  /** 前の見た目に戻す（選んだモデルを保存できなかったとき）。表示中のものと同じ参照でも読み直す */
  async function restore(vrm: AgentVrmRef): Promise<void> {
    // 頼んだ参照だけを空にして、読み直させる。表示している参照は、読み直せたときに変わる
    // （先に空にすると、戻せなかったときに「まだ保存できなかったモデルを表示している」と分からなくなる）
    requestedKey = ''
    await loadRef(vrm)
  }

  /** いま表示しているのが、このモデルか（文字列は、選んだがまだ保存できていないファイルの参照 pick:番号） */
  function isShowing(target: AgentVrmRef | string): boolean {
    const key = typeof target === 'string' ? target : keyOf(target)
    // ほかのモデルを頼んでいる（取りに行っている・読み込んでいる）最中なら false
    return !loading.value && loadedKey === key && requestedKey === key
  }

  /** 表示しているモデルを外す（保存できなかったモデルを、前の見た目に戻せなかったとき） */
  function unshow(): void {
    clear('')
  }

  return { loading, error, current, loadRef, pickFile, restore, isShowing, unshow }
}

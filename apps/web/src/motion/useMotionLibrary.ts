import { reactive } from 'vue'
import type { AgentMotions } from '@aicarnation/shared'
import { deleteVrmFile, getVrmFile, saveVrmFile } from '../db/vrmFiles'
import { useAgentsStore } from '../stores/agents'
import type { VrmViewer } from '../vrm/viewer'
import type { MotionRole } from '../vrm/motion/clips'

/** 動きの役の表示名と、いつ使うか */
export const MOTION_ROLE_INFO: { role: MotionRole; label: string; hint: string }[] = [
  { role: 'idle', label: '待機', hint: 'ふだん繰り返す動きです' },
  { role: 'thinking', label: '考え中', hint: '返事を考えている間に繰り返します（無い場合は待機）' },
  { role: 'working', label: '作業中', hint: 'Claude が作業している間に繰り返します（無い場合は待機）' },
  { role: 'talking', label: '話している', hint: '返事を話している間に繰り返します（無い場合は待機）' },
  { role: 'greet', label: 'あいさつ', hint: '画面を開いたときや、久しぶりに話しかけられたときに' },
  { role: 'joy', label: '喜ぶ', hint: 'テストが通ったときや、頭をなでられたときに' },
  { role: 'play', label: '気まぐれ', hint: '手が空いているときに、ときどき' },
]

/**
 * 動きのファイル（.vrma か Mixamo の .fbx）の割り当て。割り当てはキャラクターごとに持ち、ファイルは VRM と同じ保存先に置く。
 * 1つの役に複数のファイル（パターン）を割り当てられ、再生のたびに乱数で1つ選ぶ。
 * 何も割り当てていない役は、コードの動きで動く
 */
export function useMotionLibrary(getViewer: () => VrmViewer | null) {
  const agents = useAgentsStore()
  /** 役ごとの読み込みの失敗（表示用） */
  const errors = reactive<Partial<Record<MotionRole, string>>>({})

  /** 選んでいるキャラクターの割り当て */
  const motionsOf = (): AgentMotions => agents.current?.motions ?? {}

  /** 読み込みの世代。キャラクターを素早く切り替えたとき、前のキャラクターの読み込みの続きを捨てる */
  let generation = 0

  /** 選んでいるキャラクターの割り当てを、すべて読み込み直す（ビューアと設定の準備ができてから・キャラクターを切り替えたときに呼ぶ） */
  async function loadAll(): Promise<void> {
    const viewer = getViewer()
    if (!viewer) return
    const mine = ++generation
    viewer.clearMotionFiles()
    for (const key of Object.keys(errors)) delete errors[key as MotionRole]
    const motions = motionsOf()
    for (const { role } of MOTION_ROLE_INFO) {
      for (const assigned of motions[role] ?? []) {
        try {
          const file = await getVrmFile(assigned.fileId)
          if (!file) throw new Error(`${assigned.name} が見つかりません`)
          const data = await file.blob.arrayBuffer()
          // 読んでいる間に別のキャラクターに切り替わった：このキャラクターの動きは足さない
          if (mine !== generation) return
          // 解析（FBX は時間がかかる）のあとにも確かめる
          await viewer.addMotionFile(role, assigned.fileId, data, assigned.name, () => mine === generation)
        } catch (err) {
          if (mine !== generation) return
          errors[role] = err instanceof Error ? err.message : `${assigned.name} を読み込めませんでした`
        }
      }
    }
  }

  /**
   * 役にファイルをパターンとして足す。読めない（.vrma でも Mixamo の FBX でもない）ファイルは保存しない。
   * キャラクターに保存できなかったら、足した動きとファイルを取り消して知らせる（表示と保存をずらさない）。
   * 失敗しても例外は投げない（まとめて足すとき、残りのファイルを続けて足せるように）
   */
  async function assign(role: MotionRole, file: File): Promise<void> {
    const viewer = getViewer()
    const agent = agents.current
    if (!viewer || !agent) return
    // 足している間に別のキャラクターへ切り替えたら、表示には足さない（保存は、足し始めたキャラクターにする）
    const mine = generation
    const stillShown = () => mine === generation && agents.current?.id === agent.id
    // id は保存して決まるので、先に保存してから読み、読めなければ消す
    let fileId: string
    try {
      fileId = await saveVrmFile(file)
    } catch {
      if (stillShown()) errors[role] = `${file.name} を保存できませんでした。少し待ってから、もう一度お試しください`
      return
    }
    try {
      await viewer.addMotionFile(role, fileId, await file.arrayBuffer(), file.name, stillShown)
    } catch (err) {
      await deleteVrmFile(fileId).catch(() => undefined)
      const reason = err instanceof Error && err.message ? `（${err.message}）` : ''
      if (stillShown()) errors[role] = `${file.name} を動きのファイル（.vrma・Mixamo の .fbx）として読み込めませんでした${reason}`
      return
    }
    try {
      await agents.setMotions(agent.id, (motions) => ({ ...motions, [role]: [...(motions[role] ?? []), { fileId, name: file.name }] }))
    } catch {
      viewer.removeMotionFile(role, fileId)
      await deleteVrmFile(fileId).catch(() => undefined)
      if (stillShown()) errors[role] = `${file.name} を保存できませんでした。少し待ってから、もう一度お試しください`
      return
    }
    if (!stillShown()) {
      // 足している間に切り替えて戻ってきた：戻ったときの読み込みは、保存する前の割り当てを読んでいるので、読み込み直す
      if (agents.current?.id === agent.id) void loadAll()
      return
    }
    delete errors[role]
  }

  /**
   * 役からパターンを1つ外す（すべて外すと標準の動きに戻る。ファイルは、ほかのキャラクターも使っていなければ消える）。
   * 保存できてから表示からも外す（保存できなければ、一覧にも表示にも残したまま知らせる）
   */
  async function remove(role: MotionRole, fileId: string): Promise<void> {
    const agent = agents.current
    if (!agent) return
    try {
      await agents.setMotions(agent.id, (motions) => {
        const rest = (motions[role] ?? []).filter((m) => m.fileId !== fileId)
        const next = { ...motions }
        if (rest.length > 0) next[role] = rest
        else delete next[role]
        return next
      })
    } catch {
      if (agents.current?.id === agent.id) errors[role] = '外せませんでした（保存できませんでした）。少し待ってから、もう一度お試しください'
      return
    }
    if (agents.current?.id === agent.id) {
      getViewer()?.removeMotionFile(role, fileId)
      delete errors[role]
    }
  }

  return { errors, loadAll, assign, remove }
}

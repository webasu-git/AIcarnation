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

  /** 選んでいるキャラクターの割り当てを、すべて読み込み直す（ビューアと設定の準備ができてから・キャラクターを切り替えたときに呼ぶ） */
  async function loadAll(): Promise<void> {
    const viewer = getViewer()
    if (!viewer) return
    viewer.clearMotionFiles()
    for (const key of Object.keys(errors)) delete errors[key as MotionRole]
    const motions = motionsOf()
    for (const { role } of MOTION_ROLE_INFO) {
      for (const assigned of motions[role] ?? []) {
        try {
          const file = await getVrmFile(assigned.fileId)
          if (!file) throw new Error(`${assigned.name} が見つかりません`)
          await viewer.addMotionFile(role, assigned.fileId, await file.blob.arrayBuffer(), assigned.name)
        } catch (err) {
          errors[role] = err instanceof Error ? err.message : `${assigned.name} を読み込めませんでした`
        }
      }
    }
  }

  /** 役にファイルをパターンとして足す。読めない（.vrma でも Mixamo の FBX でもない）ファイルは保存しない */
  async function assign(role: MotionRole, file: File): Promise<void> {
    const viewer = getViewer()
    const agent = agents.current
    if (!viewer || !agent) return
    // id は保存して決まるので、先に保存してから読み、読めなければ消す
    const fileId = await saveVrmFile(file)
    try {
      await viewer.addMotionFile(role, fileId, await file.arrayBuffer(), file.name)
    } catch (err) {
      await deleteVrmFile(fileId).catch(() => undefined)
      const reason = err instanceof Error && err.message ? `（${err.message}）` : ''
      errors[role] = `${file.name} を動きのファイル（.vrma・Mixamo の .fbx）として読み込めませんでした${reason}`
      return
    }
    delete errors[role]
    const motions = motionsOf()
    await agents.setMotions(agent.id, { ...motions, [role]: [...(motions[role] ?? []), { fileId, name: file.name }] })
  }

  /** 役からパターンを1つ外す（すべて外すと標準の動きに戻る。ファイルは、ほかのキャラクターも使っていなければ消える） */
  async function remove(role: MotionRole, fileId: string): Promise<void> {
    const agent = agents.current
    if (!agent) return
    getViewer()?.removeMotionFile(role, fileId)
    const motions = motionsOf()
    const rest = (motions[role] ?? []).filter((m) => m.fileId !== fileId)
    const next = { ...motions }
    if (rest.length > 0) next[role] = rest
    else delete next[role]
    delete errors[role]
    await agents.setMotions(agent.id, next)
  }

  return { errors, loadAll, assign, remove }
}

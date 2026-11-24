import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { VrmViewer } from '../vrm/viewer'

/** 選んでいるキャラクターの動きの割り当て（試す側で切り替える） */
let motions: Record<string, { fileId: string; name: string }[]> = {}
let currentId = 'a'
/** キャラクターへの保存を失敗させるか */
let failSave = false
const deleted: string[] = []
vi.mock('../stores/agents', () => ({
  useAgentsStore: () => ({
    get current() {
      return { id: currentId, motions }
    },
    setMotions: async (_id: string, edit: (m: typeof motions) => typeof motions) => {
      if (failSave) throw new Error('保存できません')
      motions = edit(motions)
    },
  }),
}))
let fileCount = 0
vi.mock('../db/vrmFiles', () => ({
  getVrmFile: async (id: string) => ({ name: id, blob: { arrayBuffer: async () => new ArrayBuffer(1) } }),
  saveVrmFile: async () => `file${++fileCount}`,
  deleteVrmFile: async (id: string) => {
    deleted.push(id)
  },
}))

/** 足した・外した動きを覚えるだけのビューア */
function recordingViewer() {
  const shown = new Map<string, string[]>()
  const viewer = {
    clearMotionFiles: () => shown.clear(),
    addMotionFile: async (role: string, id: string, _d: ArrayBuffer, _n: string, stillWanted: () => boolean = () => true) => {
      if (stillWanted()) shown.set(role, [...(shown.get(role) ?? []), id])
    },
    removeMotionFile: (role: string, id: string) => shown.set(role, (shown.get(role) ?? []).filter((x) => x !== id)),
  } as unknown as VrmViewer
  return { viewer, shown }
}
const motionFile = (name: string) => ({ name, arrayBuffer: async () => new ArrayBuffer(1) }) as unknown as File

const { useMotionLibrary } = await import('./useMotionLibrary')

describe('動きの読み込み', () => {
  it('解析している間に別のキャラクターへ切り替えたら、前のキャラクターの動きを足さない', async () => {
    setActivePinia(createPinia())
    const added: string[] = []
    /** 解析を、試す側で好きなときに終わらせる */
    const parsing = new Map<string, () => void>()
    const viewer = {
      clearMotionFiles: () => added.splice(0),
      addMotionFile: (_role: string, id: string, _data: ArrayBuffer, _name: string, stillWanted: () => boolean = () => true) =>
        new Promise<void>((resolve) =>
          parsing.set(id, () => {
            if (stillWanted()) added.push(id)
            resolve()
          }),
        ),
    } as unknown as VrmViewer
    const library = useMotionLibrary(() => viewer)

    motions = { idle: [{ fileId: 'old-fbx', name: 'old' }] }
    const first = library.loadAll()
    await vi.waitFor(() => expect(parsing.has('old-fbx')).toBe(true))
    // 解析中に切り替える
    motions = { idle: [{ fileId: 'new-vrma', name: 'new' }] }
    const second = library.loadAll()
    await vi.waitFor(() => expect(parsing.has('new-vrma')).toBe(true))
    parsing.get('new-vrma')!()
    parsing.get('old-fbx')!()
    await Promise.all([first, second])
    expect(added).toEqual(['new-vrma'])
  })

  it('キャラクターに保存できなければ、足した動きとファイルを取り消して知らせる', async () => {
    setActivePinia(createPinia())
    motions = {}
    currentId = 'a'
    failSave = true
    deleted.length = 0
    const { viewer, shown } = recordingViewer()
    const library = useMotionLibrary(() => viewer)
    await library.assign('idle', motionFile('wave.vrma'))
    failSave = false
    expect(shown.get('idle') ?? []).toEqual([])
    expect(deleted).toHaveLength(1)
    expect(library.errors.idle).toContain('保存できませんでした')
  })

  it('外すのを保存できなければ、一覧にも表示にも残したまま知らせる', async () => {
    setActivePinia(createPinia())
    currentId = 'a'
    failSave = false
    const { viewer, shown } = recordingViewer()
    const library = useMotionLibrary(() => viewer)
    await library.assign('idle', motionFile('wave.vrma'))
    const id = shown.get('idle')![0]!
    failSave = true
    await library.remove('idle', id)
    failSave = false
    expect(shown.get('idle')).toEqual([id])
    expect(motions.idle?.map((m) => m.fileId)).toEqual([id])
    expect(library.errors.idle).toContain('外せませんでした')
  })

  it('足している間に別のキャラクターへ切り替えたら、表示には足さない（保存は足し始めたキャラクターに）', async () => {
    setActivePinia(createPinia())
    motions = {}
    currentId = 'a'
    failSave = false
    const { viewer, shown } = recordingViewer()
    const library = useMotionLibrary(() => viewer)
    const file = { name: 'late.vrma', arrayBuffer: async () => { currentId = 'b'; return new ArrayBuffer(1) } } as unknown as File
    await library.assign('idle', file)
    expect(shown.get('idle') ?? []).toEqual([])
    expect(motions.idle?.map((m) => m.name)).toEqual(['late.vrma'])
  })

  it('足している間に切り替えて戻ってきたら、足した動きを表示にも入れる', async () => {
    setActivePinia(createPinia())
    motions = {}
    currentId = 'a'
    failSave = false
    const { viewer, shown } = recordingViewer()
    const library = useMotionLibrary(() => viewer)
    // 解析の前に、別のキャラクターへ切り替えて戻る（読み込みが 2 回走り、まだ保存していない割り当てを読む）
    const file = {
      name: 'back.vrma',
      arrayBuffer: async () => {
        await library.loadAll()
        await library.loadAll()
        return new ArrayBuffer(1)
      },
    } as unknown as File
    await library.assign('idle', file)
    await vi.waitFor(() => expect(shown.get('idle')?.length).toBe(1))
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/** 保存先の代わり。failures の回数だけ、一覧の読み込みを失敗させる */
let failures = 0
let stored: { id: string; name: string; createdAt: string }[] = []
const saved: string[] = []
let saveFailures = 0
let deleteFailures = 0
const order: string[] = []
const deletedFiles: string[] = []
const lastSaved = new Map<string, unknown>()
let settingFailures = 0
const settingWrites: unknown[] = []
vi.mock('../db/agents', () => ({
  loadAgents: async () => {
    if (failures > 0) {
      failures--
      throw new Error('読めません')
    }
    return stored
  },
  saveAgent: async (agent: { id: string }) => {
    order.push(`save:${agent.id}`)
    if (saveFailures > 0) {
      saveFailures--
      throw new Error('保存できません')
    }
    saved.push(agent.id)
    lastSaved.set(agent.id, agent)
  },
  deleteAgent: async (id: string) => {
    if (deleteFailures > 0) {
      deleteFailures--
      throw new Error('消せません')
    }
    order.push(`delete:${id}`)
  },
}))
vi.mock('../db/settings', () => ({
  getSetting: async () => undefined,
  setSetting: async (_key: string, value: unknown) => {
    if (settingFailures > 0) {
      settingFailures--
      throw new Error('保存できません')
    }
    settingWrites.push(value)
  },
}))
vi.mock('../db/messages', () => ({ clearMessages: async () => undefined }))
vi.mock('../db/vrmFiles', () => ({
  deleteVrmFile: async (id: string) => {
    deletedFiles.push(id)
  },
  getVrmFile: async () => undefined,
}))
vi.mock('../api/agents', () => ({ syncAgent: async () => undefined, deleteRemoteAgent: async () => undefined }))
vi.mock('../voice/engines', () => ({
  addDictWord: async () => undefined,
  cachedEngineStyles: async () => [],
  isEngineSampleEntry: () => false,
  listDictWords: async () => [],
  parseEngineVoiceURI: () => null,
}))

const { retryTiming } = await import('../retry')
retryTiming.delays = [0, 0, 0]
retryTiming.resaveLater = 10
const { useAgentsStore } = await import('./agents')

describe('キャラクターの読み込み', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    failures = 0
    stored = [{ id: 'a', name: 'サンプル', createdAt: '2026-01-01' }]
    saved.length = 0
  })

  it('一時的に読めなくても、読み直せば読める', async () => {
    failures = 3
    const agents = useAgentsStore()
    await agents.load()
    expect(agents.agents.map((a) => a.id)).toEqual(['a'])
    expect(saved).toEqual([])
  })

  it('読めないときは失敗を返し、既定のキャラクターを作って上書きしない', async () => {
    failures = 4
    const agents = useAgentsStore()
    await expect(agents.load()).rejects.toThrow()
    expect(saved).toEqual([])
    expect(agents.agents).toEqual([])
  })

  it('本当に1体もいないときだけ、既定のキャラクターを作る', async () => {
    stored = []
    const agents = useAgentsStore()
    await agents.load()
    expect(saved).toHaveLength(1)
  })
})

describe('キャラクターの保存', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    failures = 0
    stored = [
      { id: 'a', name: 'A', createdAt: '2026-01-01', systemPrompt: '', vrm: { source: 'none', ref: '' } },
      { id: 'b', name: 'B', createdAt: '2026-01-01', systemPrompt: '', vrm: { source: 'none', ref: '' } },
    ] as never
    saved.length = 0
    saveFailures = 0
    order.length = 0
    deletedFiles.length = 0
  })

  it('変更を保存できなければ知らせ、画面にも入れない。次に保存できたら知らせを消す', async () => {
    const agents = useAgentsStore()
    await agents.load()
    saveFailures = 4
    await expect(agents.update('a', { name: 'A2' })).rejects.toThrow()
    expect(agents.unsaved.agents).toEqual(['a'])
    expect(agents.agents.find((a) => a.id === 'a')?.name).toBe('A')
    await agents.update('a', { name: 'A3' })
    expect(agents.unsaved.agents).toEqual([])
    expect(agents.agents.find((a) => a.id === 'a')?.name).toBe('A3')
  })

  it('選んだキャラクターを保存できなければ知らせ、あとで保存し直す', async () => {
    const agents = useAgentsStore()
    await agents.load()
    settingFailures = 4
    await agents.select('b')
    expect(agents.currentId).toBe('b')
    expect(agents.unsaved.current).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(agents.unsaved.current).toBe(false)
    expect(settingWrites.at(-1)).toBe('b')
  })

  it('保存のやり直しを待っている間の変更は、そのあとに重ねる（古い変更で上書きしない）', async () => {
    const agents = useAgentsStore()
    await agents.load()
    saveFailures = 2
    const first = agents.update('a', { steadyWaist: false })
    const second = agents.update('a', { talkGestures: false })
    await Promise.all([first, second])
    const a = agents.agents.find((x) => x.id === 'a')
    expect([a?.steadyWaist, a?.talkGestures]).toEqual([false, false])
    expect(lastSaved.get('a')).toMatchObject({ steadyWaist: false, talkGestures: false })
  })

  it('保存を待っている間に動きを足しても、先に足した動きを消さない', async () => {
    const agents = useAgentsStore()
    await agents.load()
    saveFailures = 2
    const add = (fileId: string) => agents.setMotions('a', (m) => ({ ...m, idle: [...(m.idle ?? []), { fileId, name: fileId }] }))
    await Promise.all([add('m1'), add('m2')])
    const idle = agents.agents.find((x) => x.id === 'a')?.motions?.idle?.map((m) => m.fileId)
    expect(idle).toEqual(['m1', 'm2'])
    expect(deletedFiles).toEqual([])
  })

  it('保存を待っている変更が済んでから、キャラクターを消す（消したキャラクターが戻らない）', async () => {
    const agents = useAgentsStore()
    await agents.load()
    saveFailures = 2
    const change = agents.update('b', { steadyWaist: false })
    await agents.remove('b')
    await change
    expect(order.at(-1)).toBe('delete:b')
  })

  it('保存できなかったキャラクターを消したら、知らせも消す。新しく作れなかったものは知らせに残さない', async () => {
    const agents = useAgentsStore()
    await agents.load()
    saveFailures = 4
    await expect(agents.update('a', { name: 'A2' })).rejects.toThrow()
    expect(agents.unsaved.agents).toEqual(['a'])
    await agents.remove('a')
    expect(agents.unsaved.agents).toEqual([])
    saveFailures = 4
    await expect(agents.duplicate('b')).rejects.toThrow()
    expect(agents.unsaved.agents).toEqual([])
  })

  it('消している途中に入った変更は保存せず、失敗を返す（消したキャラクターが戻らない。呼び出し元が表示を戻せる）', async () => {
    const agents = useAgentsStore()
    await agents.load()
    const removing = agents.remove('b')
    const late = agents.update('b', { steadyWaist: false })
    await removing
    await expect(late).rejects.toThrow()
    expect(order.filter((x) => x.endsWith(':b'))).toEqual(['delete:b'])
  })

  it('最後の 1 体を消したあと、既定のキャラクターを保存できなくても、削除は成功にする', async () => {
    stored = [stored[0]!] as never
    const agents = useAgentsStore()
    await agents.load()
    saveFailures = 4
    await agents.remove('a')
    expect(agents.agents).toHaveLength(1)
    expect(agents.agents[0]?.id).not.toBe('a')
  })

  it('消せなかったら、変更も削除も、もう一度できる', async () => {
    const agents = useAgentsStore()
    await agents.load()
    deleteFailures = 1
    await expect(agents.remove('b')).rejects.toThrow()
    await agents.update('b', { name: 'B2' })
    expect(lastSaved.get('b')).toMatchObject({ name: 'B2' })
    await agents.remove('b')
    expect(agents.agents.map((a) => a.id)).toEqual(['a'])
  })

  it('残りの 2 体を重ねて消しても、既定のキャラクターは 1 体だけ作る。同じ削除を重ねたら同じ結果を返す', async () => {
    const agents = useAgentsStore()
    await agents.load()
    await Promise.all([agents.remove('a'), agents.remove('a'), agents.remove('b')])
    expect(order.filter((x) => x === 'delete:a')).toHaveLength(1)
    expect(agents.agents).toHaveLength(1)
    expect(saved.filter((id) => id !== 'a' && id !== 'b')).toHaveLength(1)
  })
})

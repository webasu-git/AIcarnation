import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

/** 保存先の代わり。fail に入れた設定は、読むと失敗する */
const saved = new Map<string, unknown>()
const fail = new Set<string>()
const writes: string[] = []
/** この回数だけ、保存を失敗させる */
let saveFailures = 0
vi.mock('../db/settings', () => ({
  getSetting: async (key: string) => {
    if (fail.has(key)) throw new Error('読めません')
    return saved.get(key)
  },
  setSetting: async (key: string, value: unknown) => {
    if (saveFailures > 0) {
      saveFailures--
      throw new Error('保存できません')
    }
    writes.push(key)
    saved.set(key, value)
  },
}))
vi.mock('../voice/speech', () => ({ stopSpeech: () => undefined }))
vi.mock('../voice/audio', () => ({ setAudioVolume: () => undefined }))
vi.mock('../theme', () => ({ initialTheme: () => 'system', setTheme: () => undefined }))

const { retryTiming } = await import('../retry')
retryTiming.delays = [0, 0, 0]
// 保存し直すまでの間は、知らせが出ていることを確かめられる長さにする（waitFor は 50 ミリ秒ごとに見る）
retryTiming.resaveLater = 300
const { useSettingsStore } = await import('./settings')
const settle = () => new Promise((r) => setTimeout(r, 30))

describe('設定の読み込みと保存', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    saved.clear()
    fail.clear()
    writes.length = 0
    saveFailures = 0
  })

  it('1つ読めなくても、残りの設定は読み、読み終えた状態になる', async () => {
    saved.set('volume', 0.3)
    saved.set('conversationLog', true)
    saved.set('proactiveEnabled', true)
    saved.set('proactiveSessionExclude', ['D:/work/a'])
    fail.add('captionMode')
    const s = useSettingsStore()
    await s.load()
    expect(s.loaded).toBe(true)
    expect([s.volume, s.conversationLog, s.proactiveEnabled, s.proactiveSessionExclude]).toEqual([0.3, true, true, ['D:/work/a']])
    expect(s.captionMode).toBe('latest')
    expect(s.unreadable).toEqual(['captionMode'])
  })

  it('読んだ値は書き戻さない。読めずに既定の値にした設定で、保存されている値を上書きしない', async () => {
    saved.set('proactiveSessionExclude', ['D:/work/a'])
    saved.set('captionMode', 'all')
    fail.add('captionMode')
    const s = useSettingsStore()
    await s.load()
    await nextTick()
    expect(writes).toEqual([])
    expect(saved.get('captionMode')).toBe('all')
  })

  it('読み終えたあとの変更は保存する', async () => {
    const s = useSettingsStore()
    await s.load()
    s.proactiveEnabled = true
    s.proactiveSessionExclude = ['D:/work/b']
    await nextTick()
    await Promise.resolve()
    expect(saved.get('proactiveEnabled')).toBe(true)
    expect(saved.get('proactiveSessionExclude')).toEqual(['D:/work/b'])
  })

  it('一時的に保存できなくても、間を空けてやり直せば知らせない', async () => {
    const s = useSettingsStore()
    await s.load()
    saveFailures = 2
    s.volume = 0.4
    await vi.waitFor(() => expect(saved.get('volume')).toBe(0.4))
    expect(s.unsaved).toEqual([])
  })

  it('やり直しても保存できなければ知らせ、あとで保存し直して知らせを消す', async () => {
    const s = useSettingsStore()
    await s.load()
    saveFailures = 4
    s.volume = 0.2
    await vi.waitFor(() => expect(s.unsaved).toEqual(['volume']))
    await vi.waitFor(() => expect(saved.get('volume')).toBe(0.2))
    expect(s.unsaved).toEqual([])
  })

  it('やり直している間に値が変わったら、古い値で上書きしない', async () => {
    const s = useSettingsStore()
    await s.load()
    saveFailures = 1
    s.volume = 0.1
    await nextTick()
    s.volume = 0.9
    await vi.waitFor(() => expect(saved.get('volume')).toBe(0.9))
    await settle()
    expect(saved.get('volume')).toBe(0.9)
    expect(s.unsaved).toEqual([])
  })

  it('保存し直す予定の古い値で、あとから変えた値を上書きしない', async () => {
    const s = useSettingsStore()
    await s.load()
    saveFailures = 4
    s.volume = 0.1
    await vi.waitFor(() => expect(s.unsaved).toEqual(['volume']))
    // 保存し直す前に変える。この保存も1回失敗してやり直している間に、保存し直しの時刻が来る
    saveFailures = 1
    s.volume = 0.7
    await vi.waitFor(() => expect(saved.get('volume')).toBe(0.7))
    // 保存し直しの時刻（300 ミリ秒）を過ぎても、古い値に戻らない
    await new Promise((r) => setTimeout(r, 400))
    expect(saved.get('volume')).toBe(0.7)
    expect(s.unsaved).toEqual([])
  })
})

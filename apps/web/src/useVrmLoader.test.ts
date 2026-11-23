import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VrmViewer } from './vrm/viewer'

/** ファイルを取りに行く処理を、試す側で好きな順に終わらせる */
const pending = new Map<string, (found: boolean) => void>()
vi.mock('./db/vrmFiles', () => ({
  getVrmFile: (ref: string) =>
    new Promise((resolve) => {
      pending.set(ref, (found) =>
        resolve(found ? { name: `${ref}.vrm`, blob: { arrayBuffer: async () => new TextEncoder().encode(ref).buffer } } : undefined),
      )
    }),
  saveVrmFile: async () => 'saved',
}))

const { useVrmLoader } = await import('./useVrmLoader')

/** 表示したモデル（読み込んだデータの中身）を順に覚えるだけのビューア */
function fakeViewer() {
  const shown: string[] = []
  const viewer = {
    load: async (data: ArrayBuffer) => {
      const title = new TextDecoder().decode(data)
      shown.push(title)
      return { spec: 'VRM', title }
    },
    clear: () => shown.push('(clear)'),
  } as unknown as VrmViewer
  return { viewer, shown }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('useVrmLoader', () => {
  beforeEach(() => pending.clear())

  it('あとから頼んだモデルが先に届いても、先に頼んだ遅いモデルで上書きしない', async () => {
    const { viewer, shown } = fakeViewer()
    const loader = useVrmLoader(() => viewer)
    // 起動時：先頭のキャラクター（大きくて遅い）→ 選択中のキャラクター（小さくて速い）の順に頼まれる
    const first = loader.loadRef({ source: 'local', ref: 'big-first' })
    const selected = loader.loadRef({ source: 'local', ref: 'small-selected' })
    pending.get('small-selected')?.(true)
    await flush()
    pending.get('big-first')?.(true)
    await Promise.all([first, selected])
    expect(shown).toEqual(['small-selected'])
    expect(loader.current.value).toBe('small-selected（VRM）')
    expect(loader.loading.value).toBe(false)
  })

  it('読み込み中のものを、もう一度頼まれても読み直さない', async () => {
    const { viewer, shown } = fakeViewer()
    const loader = useVrmLoader(() => viewer)
    const a = loader.loadRef({ source: 'local', ref: 'a' })
    const again = loader.loadRef({ source: 'local', ref: 'a' })
    pending.get('a')?.(true)
    await Promise.all([a, again])
    expect(shown).toEqual(['a'])
  })

  it('ファイルが見つからなければ外して知らせる。古い頼みごとの「見つからない」は無視する', async () => {
    const { viewer, shown } = fakeViewer()
    const loader = useVrmLoader(() => viewer)
    const missing = loader.loadRef({ source: 'local', ref: 'missing' })
    const ok = loader.loadRef({ source: 'local', ref: 'ok' })
    pending.get('ok')?.(true)
    await flush()
    pending.get('missing')?.(false)
    await Promise.all([missing, ok])
    expect(shown).toEqual(['ok'])
    expect(loader.error.value).toBe('')

    const gone = loader.loadRef({ source: 'local', ref: 'gone' })
    pending.get('gone')?.(false)
    await gone
    expect(shown).toEqual(['ok', '(clear)'])
    expect(loader.error.value).toContain('見つかりません')
  })
})

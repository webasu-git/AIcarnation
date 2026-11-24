import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VrmViewer } from './vrm/viewer'

/** ファイルを取りに行く処理を、試す側で好きな順に終わらせる */
const pending = new Map<string, (found: boolean) => void>()
/** モデルの保存を、試す側で終わらせる */
let finishSave = () => {}
/** この参照は、取りに行くと失敗する（保存先に一時的につながらないなど） */
const broken = new Set<string>()
/** この参照は、この回数だけ取りに行くのに失敗する */
const flaky = new Map<string, number>()
vi.mock('./db/vrmFiles', () => ({
  getVrmFile: (ref: string) =>
    new Promise((resolve, reject) => {
      if (broken.has(ref)) return reject(new Error('つながりません'))
      const left = flaky.get(ref) ?? 0
      if (left > 0) {
        flaky.set(ref, left - 1)
        return reject(new Error('一時的につながりません'))
      }
      pending.set(ref, (found) =>
        resolve(found ? { name: `${ref}.vrm`, blob: { arrayBuffer: async () => new TextEncoder().encode(ref).buffer } } : undefined),
      )
    }),
  saveVrmFile: () => new Promise((resolve) => (finishSave = () => resolve('saved'))),
}))

const { retryTiming } = await import('./retry')
retryTiming.delays = [0, 0, 0]
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

  it('取りに行けなかったら知らせ、同じモデルをもう一度頼めば読み直す', async () => {
    const { viewer, shown } = fakeViewer()
    const loader = useVrmLoader(() => viewer)
    broken.add('flaky')
    await loader.loadRef({ source: 'local', ref: 'flaky' })
    expect(loader.error.value).toContain('読み込めませんでした')
    broken.delete('flaky')
    const again = loader.loadRef({ source: 'local', ref: 'flaky' })
    await flush()
    pending.get('flaky')?.(true)
    await again
    expect(shown).toEqual(['flaky'])
  })

  it('一時的に取りに行けなくても、間を空けて取り直して表示する', async () => {
    const { viewer, shown } = fakeViewer()
    const loader = useVrmLoader(() => viewer)
    flaky.set('slow', 2)
    const loading = loader.loadRef({ source: 'local', ref: 'slow' })
    await vi.waitFor(() => expect(pending.has('slow')).toBe(true))
    pending.get('slow')?.(true)
    await loading
    expect(shown).toEqual(['slow'])
    expect(loader.error.value).toBe('')
  })

  it('前の見た目に戻すときは、同じ参照でも読み直す', async () => {
    const { viewer, shown } = fakeViewer()
    const loader = useVrmLoader(() => viewer)
    const first = loader.loadRef({ source: 'local', ref: 'before' })
    pending.get('before')?.(true)
    await first
    const back = loader.restore({ source: 'local', ref: 'before' })
    await vi.waitFor(() => expect(pending.has('before')).toBe(true))
    pending.get('before')?.(true)
    await back
    expect(shown).toEqual(['before', 'before'])
  })

  it('選んだモデルを保存している間にほかのモデルを頼まれても、戻ったときに選んだモデルを読み直す', async () => {
    const { viewer, shown } = fakeViewer()
    const loader = useVrmLoader(() => viewer)
    const file = { name: 'picked.vrm', arrayBuffer: async () => new TextEncoder().encode('picked').buffer } as unknown as File
    const picking = loader.pickFile(file)
    await vi.waitFor(() => expect(shown).toEqual(['picked']))
    // 保存を待っている間に、別のキャラクター（モデル other）へ切り替える
    const other = loader.loadRef({ source: 'local', ref: 'other' })
    pending.get('other')?.(true)
    await other
    finishSave()
    const vrm = await picking
    // 選んだキャラクターに戻す
    const back = loader.loadRef(vrm!)
    await vi.waitFor(() => expect(pending.has('saved')).toBe(true))
    pending.get('saved')?.(true)
    await back
    expect(shown).toEqual(['picked', 'other', 'saved'])
  })

  it('いま表示しているモデルかを答える（読み込み中は false）', async () => {
    const { viewer } = fakeViewer()
    const loader = useVrmLoader(() => viewer)
    const a = loader.loadRef({ source: 'local', ref: 'a' })
    expect(loader.isShowing({ source: 'local', ref: 'a' })).toBe(false)
    pending.get('a')?.(true)
    await a
    expect(loader.isShowing({ source: 'local', ref: 'a' })).toBe(true)
    expect(loader.isShowing({ source: 'local', ref: 'b' })).toBe(false)
  })

  it('選んだファイルを保存できなければ、表示した参照を知らせる。別に選んだファイルとは区別する', async () => {
    const { viewer } = fakeViewer()
    const loader = useVrmLoader(() => viewer)
    const file = (name: string) => ({ name: `${name}.vrm`, arrayBuffer: async () => new TextEncoder().encode(name).buffer }) as unknown as File
    const a = loader.pickFile(file('a'))
    await vi.waitFor(() => expect(loader.loading.value).toBe(false))
    const b = loader.pickFile(file('b'))
    await vi.waitFor(() => expect(loader.current.value).toContain('b'))
    finishSave = () => {}
    // a・b とも保存待ち。表示しているのは b で、a ではない
    const { PickSaveError } = await import('./useVrmLoader')
    void a.catch(() => undefined)
    void b.catch(() => undefined)
    expect(loader.isShowing('pick:1')).toBe(false)
    expect(loader.isShowing(`pick:${2}`) || loader.isShowing('pick:2')).toBe(true)
    expect(new PickSaveError('pick:2', new Error('x')).shownKey).toBe('pick:2')
    loader.unshow()
    expect(loader.isShowing('pick:2')).toBe(false)
  })

  it('前の見た目に戻せなかったら、保存できなかったモデルを表示しているとわかる（外せる）', async () => {
    const { viewer } = fakeViewer()
    const loader = useVrmLoader(() => viewer)
    const picking = loader.pickFile({ name: 'p.vrm', arrayBuffer: async () => new TextEncoder().encode('p').buffer } as unknown as File)
    await vi.waitFor(() => expect(loader.current.value).toContain('p'))
    void picking.catch(() => undefined)
    const shownKey = 'pick:' + /[0-9]+/.exec(JSON.stringify([...Array(100).keys()].find((n) => loader.isShowing(`pick:${n}`))))![0]
    broken.add('gone-before')
    await loader.restore({ source: 'local', ref: 'gone-before' })
    broken.delete('gone-before')
    expect(loader.isShowing(shownKey)).toBe(true)
    loader.unshow()
    expect(loader.isShowing(shownKey)).toBe(false)
  })
})

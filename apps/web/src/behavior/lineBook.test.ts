import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 同梱サーバーへの問い合わせの代わり。台詞帳の GET はこの状態を返す */
let getStatus = 200
let putStatus = 204
const calls: string[] = []
const generateLines = vi.fn(async () => ({ lines: {} }))
vi.mock('../runtime', () => ({
  IS_COMPANION: true,
  companionFetch: async (_path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    calls.push(method)
    if (method === 'PUT') return new Response(null, { status: putStatus })
    return new Response(JSON.stringify({ agentId: 'a', signature: 'old', lines: {}, createdAt: '' }), { status: getStatus })
  },
}))
vi.mock('../api/agents', () => ({ generateLines }))

const { retryTiming } = await import('../retry')
retryTiming.delays = [0, 0, 0]
const { loadLineBook } = await import('./lineBook')
const agent = { id: 'a', name: 'サンプル', firstPerson: '私', tone: '', personality: '', background: '' } as never

describe('台詞帳の読み込み', () => {
  beforeEach(() => {
    calls.length = 0
    generateLines.mockClear()
  })

  it('読めないとき（401・500 など）は読み直し、それでもだめなら作り直さず、保存済みの台詞帳を上書きしない', async () => {
    getStatus = 500
    await loadLineBook(agent)
    expect(generateLines).not.toHaveBeenCalled()
    expect(calls).toEqual(['GET', 'GET', 'GET', 'GET'])
  })

  it('保存されていないときだけ作り、保存できなければ間を空けてやり直す', async () => {
    getStatus = 404
    putStatus = 500
    await loadLineBook(agent)
    expect(generateLines).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['GET', 'PUT', 'PUT', 'PUT', 'PUT'])
  })
})

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { EMOTION_TAG_INSTRUCTION, type AgentDefinition, type GeneratedAgent } from '@aicarnation/shared'
import { createApp } from '../src/app'
import { createMockModel } from '../src/claude'
import { finalizeGenerated, GenerationError, type AgentGenerator, type GenerateInput } from '../src/generator'
import { createMockVoiceSuggester, type VoiceSuggester } from '../src/voice'

const generated: GeneratedAgent = {
  name: 'ミナ',
  firstPerson: 'わたし',
  tone: '丁寧',
  personality: '好奇心旺盛',
  background: '図書館で働いていた',
  topics: ['読書'],
  forbidden: ['長文で返す'],
  appearance: '黒髪ボブ',
  systemPrompt: 'あなたはミナです。',
}

function appWith(generator: AgentGenerator, voiceSuggester: VoiceSuggester = createMockVoiceSuggester()) {
  return createApp({ getModel: () => createMockModel(), getGenerator: () => generator, getVoiceSuggester: () => voiceSuggester })
}

const okGenerator: AgentGenerator = { generate: async () => finalizeGenerated(generated) }

async function registeredId(app: ReturnType<typeof appWith>): Promise<string> {
  const id = crypto.randomUUID()
  await app.request('/auth/anon', { method: 'POST', headers: { Authorization: `Bearer ${id}` } }, env)
  return id
}

function generateRequest(anonId: string, description: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${anonId}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  }
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: crypto.randomUUID(),
    ...finalizeGenerated(generated),
    vrm: { source: 'none', ref: '' },
    voice: { voiceURI: '', rate: 1, pitch: 1 },
    createdAt: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  }
}

describe('finalizeGenerated', () => {
  it('システムプロンプトに感情タグの指示を足し、二重には足さない', () => {
    const once = finalizeGenerated(generated)
    expect(once.systemPrompt.endsWith(EMOTION_TAG_INSTRUCTION)).toBe(true)
    expect(finalizeGenerated(once).systemPrompt).toBe(once.systemPrompt)
  })

  it('名前やシステムプロンプトが空なら invalid_output', () => {
    expect(() => finalizeGenerated({ ...generated, name: ' ' })).toThrow(GenerationError)
    expect(() => finalizeGenerated(null)).toThrow(GenerationError)
  })
})

describe('/agents/generate', () => {
  it('説明文から定義を返し、利用回数を数える', async () => {
    const app = appWith(okGenerator)
    const id = await registeredId(app)
    const res = await app.request('/agents/generate', generateRequest(id, '図書館の司書'), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ name: 'ミナ', topics: ['読書'] })
    const usage = await (await app.request('/usage', { headers: { Authorization: `Bearer ${id}` } }, env)).json()
    expect(usage).toMatchObject({ used: 1 })
  })

  it('説明が空・長すぎるなら 400', async () => {
    const app = appWith(okGenerator)
    const id = await registeredId(app)
    for (const d of ['', '   ', 'あ'.repeat(2001), 123]) {
      const res = await app.request('/agents/generate', generateRequest(id, d), env)
      expect(res.status).toBe(400)
    }
  })

  it('拒否されたら 422(refusal)。モデルを呼んだ分は利用回数に数える（先に数えて戻さない）', async () => {
    const app = appWith({
      generate: async () => {
        throw new GenerationError('refusal', 'この説明からは作れませんでした')
      },
    })
    const id = await registeredId(app)
    const res = await app.request('/agents/generate', generateRequest(id, 'x'), env)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'refusal' })
    const usage = await (await app.request('/usage', { headers: { Authorization: `Bearer ${id}` } }, env)).json()
    expect(usage).toMatchObject({ used: 1 })
  })

  it('認証が無ければ 401', async () => {
    const res = await appWith(okGenerator).request('/agents/generate', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })
})

describe('/agents/:id の同期', () => {
  function put(anonId: string, agent: AgentDefinition, id = agent.id): RequestInit & { path: string } {
    return {
      path: `/agents/${id}`,
      method: 'PUT',
      headers: { Authorization: `Bearer ${anonId}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(agent),
    }
  }

  it('保存・取得・更新・削除ができる', async () => {
    const app = appWith(okGenerator)
    const anon = await registeredId(app)
    const agent = definition()
    const auth = { headers: { Authorization: `Bearer ${anon}` } }

    const { path, ...init } = put(anon, agent)
    expect((await app.request(path, init, env)).status).toBe(200)
    expect(await (await app.request(path, auth, env)).json()).toEqual(agent)

    const updated = { ...agent, name: 'ミナ2', updatedAt: '2026-10-25T00:00:00.000Z' }
    const second = put(anon, updated)
    expect((await app.request(second.path, second, env)).status).toBe(200)
    expect(await (await app.request(path, auth, env)).json()).toMatchObject({ name: 'ミナ2' })

    expect((await app.request(path, { method: 'DELETE', ...auth }, env)).status).toBe(204)
    expect((await app.request(path, auth, env)).status).toBe(404)
  })

  it('他の利用者の定義は読めず、上書きもできない', async () => {
    const app = appWith(okGenerator)
    const owner = await registeredId(app)
    const other = await registeredId(app)
    const agent = definition()
    const first = put(owner, agent)
    await app.request(first.path, first, env)

    expect((await app.request(first.path, { headers: { Authorization: `Bearer ${other}` } }, env)).status).toBe(404)
    const hijack = put(other, { ...agent, name: '乗っ取り' })
    expect((await app.request(hijack.path, hijack, env)).status).toBe(404)
    const own = await app.request(first.path, { headers: { Authorization: `Bearer ${owner}` } }, env)
    expect(await own.json()).toMatchObject({ name: 'ミナ' })
  })

  it('形が不正・id 不一致なら 400', async () => {
    const app = appWith(okGenerator)
    const anon = await registeredId(app)
    const agent = definition()
    const mismatch = put(anon, agent, crypto.randomUUID())
    expect((await app.request(mismatch.path, mismatch, env)).status).toBe(400)
    const broken = put(anon, { ...agent, topics: 'x' as unknown as string[] })
    expect((await app.request(broken.path, broken, env)).status).toBe(400)
  })
})

describe('/agents/generate の画像入力', () => {
  /** 受け取った入力を記録するモック */
  function recordingGenerator() {
    const inputs: GenerateInput[] = []
    const generator: AgentGenerator = {
      async generate(input) {
        inputs.push(input)
        return finalizeGenerated(generated)
      },
    }
    return { generator, inputs }
  }

  const png = { mediaType: 'image/png', data: btoa('fake-png-bytes') }

  function body(payload: unknown, anonId: string): RequestInit {
    return {
      method: 'POST',
      headers: { Authorization: `Bearer ${anonId}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  }

  it('画像だけでも作れ、画像は生成にそのまま渡す', async () => {
    const { generator, inputs } = recordingGenerator()
    const app = appWith(generator)
    const id = await registeredId(app)
    const res = await app.request('/agents/generate', body({ images: [png] }, id), env)
    expect(res.status).toBe(200)
    expect(inputs[0]).toEqual({ description: '', images: [png] })
  })

  it('画像の枚数・形式・大きさが条件外なら 400', async () => {
    const app = appWith(okGenerator)
    const id = await registeredId(app)
    const tooBig = { mediaType: 'image/jpeg', data: 'A'.repeat(Math.ceil((5 * 1024 * 1024 + 10) / 3) * 4) }
    for (const images of [[png, png, png, png], [{ mediaType: 'image/bmp', data: 'AAAA' }], [tooBig], [{ mediaType: 'image/png' }]]) {
      const res = await app.request('/agents/generate', body({ images }, id), env)
      expect(res.status).toBe(400)
    }
  })
})

describe('/agents/suggest-voice', () => {
  const agent = { name: 'ハル', firstPerson: 'ぼく', tone: '元気', personality: '明るい', appearance: '茶髪' }
  const voices = [
    { voiceURI: 'en-1', name: 'English', lang: 'en-US' },
    { voiceURI: 'ja-1', name: '日本語', lang: 'ja-JP' },
  ]

  function body(payload: unknown, anonId: string): RequestInit {
    return {
      method: 'POST',
      headers: { Authorization: `Bearer ${anonId}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  }

  it('推薦された声を返し、利用回数には数えない', async () => {
    const app = appWith(okGenerator, { suggest: async () => ({ voiceURI: 'en-1', reason: '元気だから' }) })
    const id = await registeredId(app)
    const res = await app.request('/agents/suggest-voice', body({ agent, voices }, id), env)
    expect(await res.json()).toEqual({ voiceURI: 'en-1', reason: '元気だから' })
    const usage = await (await app.request('/usage', { headers: { Authorization: `Bearer ${id}` } }, env)).json()
    expect(usage).toMatchObject({ used: 0 })
  })

  it('推薦に失敗したら日本語の声を返す', async () => {
    const app = appWith(okGenerator, {
      suggest: async () => {
        throw new Error('boom')
      },
    })
    const id = await registeredId(app)
    const res = await app.request('/agents/suggest-voice', body({ agent, voices }, id), env)
    expect(await res.json()).toMatchObject({ voiceURI: 'ja-1' })
  })

  it('声の一覧が空・不正なら 400', async () => {
    const app = appWith(okGenerator)
    const id = await registeredId(app)
    for (const payload of [{ agent, voices: [] }, { agent, voices: [{ voiceURI: 1 }] }, { voices }]) {
      expect((await app.request('/agents/suggest-voice', body(payload, id), env)).status).toBe(400)
    }
  })

  it('長すぎる声の名前は 400、大きすぎる本文は 413 で断る（そのままモデルに渡さない）', async () => {
    const app = appWith(okGenerator)
    const id = await registeredId(app)
    const long = [{ voiceURI: 'x'.repeat(201), name: 'a', lang: 'ja-JP' }]
    expect((await app.request('/agents/suggest-voice', body({ agent, voices: long }, id), env)).status).toBe(400)
    const huge = { agent: { ...agent, personality: 'あ'.repeat(70_000) }, voices }
    expect((await app.request('/agents/suggest-voice', body(huge, id), env)).status).toBe(413)
  })
})

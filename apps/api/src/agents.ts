import { Hono } from 'hono'
import {
  AGENT_IMAGE_TYPES,
  MAX_AGENT_DESCRIPTION_CHARS,
  MAX_AGENT_IMAGE_BYTES,
  MAX_AGENT_IMAGES,
  MAX_AGENT_JSON_BYTES,
  MAX_VOICE_OPTIONS,
  base64ByteLength,
  validateAgentDefinition,
  type AgentDefinition,
  type AgentImage,
  type SuggestVoiceRequest,
} from '@aicarnation/shared'
import type { AppEnv, Env } from './env'
import { classifyClaudeError } from './claude'
import { GenerationError, type AgentGenerator, type GenerateInput } from './generator'
import { fallbackVoice, type VoiceSuggester } from './voice'
import { USAGE_LIMIT_MESSAGE, nextResetJst, reserveUsage, reserveVoiceSuggestion } from './usage'
import { logId } from './log'
/** 画面が作るエージェントの id の形（crypto.randomUUID） */
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})

/** /agents/generate のリクエストを検証する */
export function parseGenerateRequest(body: unknown): Parsed<GenerateInput> {
  const b = asRecord(body)
  if (b.description !== undefined && typeof b.description !== 'string') return { ok: false, reason: '説明が不正です' }
  const description = ((b.description as string | undefined) ?? '').trim()
  if (description.length > MAX_AGENT_DESCRIPTION_CHARS) {
    return { ok: false, reason: `説明は${MAX_AGENT_DESCRIPTION_CHARS}文字までです` }
  }
  const rawImages = b.images ?? []
  if (!Array.isArray(rawImages) || rawImages.length > MAX_AGENT_IMAGES) {
    return { ok: false, reason: `画像は${MAX_AGENT_IMAGES}枚までです` }
  }
  const images: AgentImage[] = []
  for (const img of rawImages) {
    const { mediaType, data } = asRecord(img)
    if (!(AGENT_IMAGE_TYPES as readonly unknown[]).includes(mediaType) || typeof data !== 'string' || !data) {
      return { ok: false, reason: '画像は JPEG / PNG / WebP / GIF にしてください' }
    }
    if (base64ByteLength(data) > MAX_AGENT_IMAGE_BYTES) return { ok: false, reason: '画像は1枚5MBまでです' }
    images.push({ mediaType: mediaType as AgentImage['mediaType'], data })
  }
  if (!description && images.length === 0) return { ok: false, reason: '説明か画像のどちらかを入れてください' }
  return { ok: true, value: { description, images } }
}

const VOICE_AGENT_FIELDS = ['name', 'firstPerson', 'tone', 'personality', 'appearance'] as const
/** 声の一覧の1件の長さの上限（voiceURI と名前、言語タグ） */
const MAX_VOICE_URI_CHARS = 200
const MAX_VOICE_LANG_CHARS = 35
/** 1人が同期できるエージェントの数 */
const MAX_AGENTS_PER_USER = 50

/** /agents/suggest-voice のリクエストを検証する */
export function parseSuggestVoiceRequest(body: unknown): Parsed<SuggestVoiceRequest> {
  const b = asRecord(body)
  const agent = asRecord(b.agent)
  if (VOICE_AGENT_FIELDS.some((f) => typeof agent[f] !== 'string')) return { ok: false, reason: 'エージェントの情報が不正です' }
  if (!Array.isArray(b.voices) || b.voices.length === 0 || b.voices.length > MAX_VOICE_OPTIONS) {
    return { ok: false, reason: `声の一覧は1〜${MAX_VOICE_OPTIONS}件にしてください` }
  }
  const voices: SuggestVoiceRequest['voices'] = []
  for (const v of b.voices) {
    const { voiceURI, name, lang } = asRecord(v)
    if (typeof voiceURI !== 'string' || typeof name !== 'string' || typeof lang !== 'string') {
      return { ok: false, reason: '声の一覧が不正です' }
    }
    // そのままモデルへの入力と出力の候補になるので、長すぎる値は断る
    if (!voiceURI || voiceURI.length > MAX_VOICE_URI_CHARS || name.length > MAX_VOICE_URI_CHARS || lang.length > MAX_VOICE_LANG_CHARS) {
      return { ok: false, reason: '声の一覧が不正です' }
    }
    voices.push({ voiceURI, name, lang })
  }
  // 推薦に要るのは人柄の要約だけなので、長すぎる文は切る
  const pick = Object.fromEntries(VOICE_AGENT_FIELDS.map((f) => [f, (agent[f] as string).slice(0, 500)]))
  return { ok: true, value: { agent: pick as SuggestVoiceRequest['agent'], voices } }
}

export function agentRoutes(getGenerator: (env: Env) => AgentGenerator, getVoiceSuggester: (env: Env) => VoiceSuggester) {
  const app = new Hono<AppEnv>()

  /** 説明文・画像からエージェント定義を作る。利用回数は会話と共通で数える */
  app.post('/agents/generate', async (c) => {
    const parsed = parseGenerateRequest(await c.req.json().catch(() => null))
    if (!parsed.ok) return c.json({ code: 'invalid_request', message: parsed.reason }, 400)

    const anonId = c.get('anonId')
    // 数える前に、モデルを用意できるかを確かめる（設定が足りないのに回数だけ減らさない。会話と同じ順）
    let generator: AgentGenerator
    try {
      generator = getGenerator(c.env)
    } catch {
      return c.json({ code: 'upstream_error', message: 'サーバーの設定が不足しています' }, 500)
    }
    // モデルを呼ぶ前に1回分を数える（失敗しても戻さない。呼んだ分の費用はかかっているため）
    if (!(await reserveUsage(c.env, anonId))) {
      return c.json({ code: 'usage_limit', message: USAGE_LIMIT_MESSAGE, resetsAt: nextResetJst() }, 429)
    }

    try {
      // 利用者が接続を切ったら、モデルの呼び出しも止める（回数は先に数えてあるので、上限のすり抜けにはならない）
      const agent = await generator.generate(parsed.value, c.req.raw.signal)
      console.log(JSON.stringify({ type: 'generate', user: await logId(anonId), at: new Date().toISOString(), images: parsed.value.images.length }))
      return c.json(agent)
    } catch (err) {
      if (err instanceof GenerationError) {
        return c.json({ code: err.code, message: err.message }, err.code === 'refusal' ? 422 : 502)
      }
      const code = classifyClaudeError(err)
      console.log(JSON.stringify({ type: 'generate_error', user: await logId(anonId), at: new Date().toISOString(), code }))
      return c.json(
        { code, message: code === 'upstream_busy' ? '混み合っています。少し待ってから試してください' : '定義を作れませんでした' },
        code === 'upstream_busy' ? 503 : 502,
      )
    }
  })

  /**
   * ブラウザで使える声の一覧から、エージェントに合う声を1つ推薦する。
   * 軽い処理で作成画面から自動で呼ぶため、会話の利用回数には数えず、別に1日の上限を設ける（超えたら推薦せず日本語の声を返す）
   */
  app.post('/agents/suggest-voice', async (c) => {
    const parsed = parseSuggestVoiceRequest(await c.req.json().catch(() => null))
    if (!parsed.ok) return c.json({ code: 'invalid_request', message: parsed.reason }, 400)
    // 数える前に、モデルを用意できるかを確かめる（設定が足りないのに回数だけ減らさない）
    let suggester: VoiceSuggester
    try {
      suggester = getVoiceSuggester(c.env)
    } catch {
      return c.json({ voiceURI: fallbackVoice(parsed.value), reason: '推薦できなかったため、日本語の声を選びました' })
    }
    if (!(await reserveVoiceSuggestion(c.env, c.get('anonId')))) {
      return c.json({ voiceURI: fallbackVoice(parsed.value), reason: '今日の推薦の上限に達したため、日本語の声を選びました' })
    }
    try {
      return c.json(await suggester.suggest(parsed.value, c.req.raw.signal))
    } catch (err) {
      // 推薦できなくても作成は続けられるよう、日本語の声を返す
      const code = classifyClaudeError(err)
      console.log(JSON.stringify({ type: 'suggest_voice_error', user: await logId(c.get('anonId')), at: new Date().toISOString(), code }))
      return c.json({ voiceURI: fallbackVoice(parsed.value), reason: '推薦できなかったため、日本語の声を選びました' })
    }
  })

  // --- 定義JSONの同期（D1）。ローカル（IndexedDB）が正で、ここはバックアップ ---

  app.get('/agents/:id', async (c) => {
    const row = await c.env.DB.prepare('SELECT definition FROM agents WHERE id = ? AND anon_id = ?')
      .bind(c.req.param('id'), c.get('anonId'))
      .first<{ definition: string }>()
    if (!row) return c.json({ code: 'not_found', message: '見つかりません' }, 404)
    return c.json(JSON.parse(row.definition) as AgentDefinition)
  })

  app.put('/agents/:id', async (c) => {
    const text = await c.req.text()
    if (new TextEncoder().encode(text).byteLength > MAX_AGENT_JSON_BYTES) {
      return c.json({ code: 'invalid_request', message: '定義が大きすぎます' }, 413)
    }
    let definition: unknown
    try {
      definition = JSON.parse(text)
    } catch {
      return c.json({ code: 'invalid_request', message: 'JSON の形が不正です' }, 400)
    }
    const problem = validateAgentDefinition(definition)
    if (problem) return c.json({ code: 'invalid_request', message: problem }, 400)
    const agent = definition as AgentDefinition
    if (agent.id !== c.req.param('id')) {
      return c.json({ code: 'invalid_request', message: 'id が一致しません' }, 400)
    }
    // id は画面が作る UUID だけを受け付ける。id は全利用者で 1 つの表の主キーなので、短い・決まった id を許すと、
    // ほかの利用者が使いそうな id を先に取って、その人の同期を失敗させ続けることができる
    if (!AGENT_ID.test(agent.id)) {
      return c.json({ code: 'invalid_request', message: 'id の形が不正です' }, 400)
    }

    // 1人が同期できる数に上限を設ける（新しく足すときだけ数える）
    const anonId = c.get('anonId')
    const exists = await c.env.DB.prepare('SELECT 1 FROM agents WHERE id = ? AND anon_id = ?').bind(agent.id, anonId).first()
    if (!exists) {
      const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM agents WHERE anon_id = ?').bind(anonId).first<{ n: number }>()
      if ((row?.n ?? 0) >= MAX_AGENTS_PER_USER) {
        return c.json({ code: 'invalid_request', message: `同期できるエージェントは${MAX_AGENTS_PER_USER}体までです` }, 400)
      }
    }

    // 他の利用者の同じ id は上書きしない
    const result = await c.env.DB.prepare(
      `INSERT INTO agents (id, anon_id, definition, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET definition = excluded.definition, updated_at = excluded.updated_at
       WHERE agents.anon_id = excluded.anon_id`,
    )
      .bind(agent.id, c.get('anonId'), text, agent.updatedAt)
      .run()
    if (result.meta.changes === 0) return c.json({ code: 'not_found', message: '見つかりません' }, 404)
    return c.json({ ok: true })
  })

  app.delete('/agents/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM agents WHERE id = ? AND anon_id = ?').bind(c.req.param('id'), c.get('anonId')).run()
    return c.body(null, 204)
  })

  return app
}

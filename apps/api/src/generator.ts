import Anthropic from '@anthropic-ai/sdk'
import { AGENT_SPEECH_RULES, withEmotionInstruction, type AgentImage, type GeneratedAgent } from '@aicarnation/shared'

export interface GenerateInput {
  description: string
  images: AgentImage[]
}

/** エージェント定義の生成。テストではモックに差し替える */
export interface AgentGenerator {
  generate(input: GenerateInput): Promise<GeneratedAgent>
}

/** Claude が拒否した、または定義として使えない出力を返したとき */
export class GenerationError extends Error {
  constructor(
    readonly code: 'refusal' | 'invalid_output',
    message: string,
  ) {
    super(message)
  }
}

const SYSTEM_PROMPT = `あなたは対話キャラクターの設定を作るアシスタントです。
ユーザーの説明や画像から、3Dアバターとして会話するキャラクターの定義を日本語で作ってください。
画像がある場合は、外見・雰囲気・服装から性格と口調を推測して反映し、appearance には画像の見た目を書いてください。

- name: キャラクターの名前（説明に無ければ考える）
- firstPerson: 一人称
- tone: 口調。語尾や話し方の特徴を具体的に
- personality: 性格
- background: 背景設定（1〜3文）
- topics: 得意な話題（2〜5個）
- forbidden: 会話で避けること（1〜4個。キャラクターとしての禁止事項）
- appearance: 見た目（髪色・髪型・服装・雰囲気）。説明に無ければ性格から想像する
- systemPrompt: 上記をまとめた、キャラクターを演じるための指示文。「あなたは〜です。」と二人称で書く。
  一人称・口調・性格・背景・得意な話題・避けることをすべて含め、
  「返答は1〜3文の短い話し言葉にし、箇条書きや見出しは使わない」ことも書く。
  感情タグの指示はアプリが後から付けるので書かない。

${AGENT_SPEECH_RULES}`

/** 構造化出力のスキーマ（文字数などの制約はAPIが受け付けないため型だけ指定する） */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    firstPerson: { type: 'string' },
    tone: { type: 'string' },
    personality: { type: 'string' },
    background: { type: 'string' },
    topics: { type: 'array', items: { type: 'string' } },
    forbidden: { type: 'array', items: { type: 'string' } },
    appearance: { type: 'string' },
    systemPrompt: { type: 'string' },
  },
  required: ['name', 'firstPerson', 'tone', 'personality', 'background', 'topics', 'forbidden', 'appearance', 'systemPrompt'],
  additionalProperties: false,
} as const

/** 生成結果を検証し、システムプロンプトに感情タグの指示を足す */
export function finalizeGenerated(raw: unknown): GeneratedAgent {
  const v = raw as Partial<Record<keyof GeneratedAgent, unknown>> | null
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [])
  const name = str(v?.name)
  const systemPrompt = str(v?.systemPrompt)
  if (!name || !systemPrompt) throw new GenerationError('invalid_output', '定義を作れませんでした')
  return {
    name,
    firstPerson: str(v?.firstPerson),
    tone: str(v?.tone),
    personality: str(v?.personality),
    background: str(v?.background),
    topics: list(v?.topics),
    forbidden: list(v?.forbidden),
    appearance: str(v?.appearance),
    systemPrompt: withEmotionInstruction(systemPrompt),
  }
}

export function createClaudeGenerator(apiKey: string, model: string): AgentGenerator {
  const client = new Anthropic({ apiKey })
  return {
    async generate({ description, images }) {
      const message = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              // 画像は保存せず、このリクエストにだけ含める
              ...images.map((img) => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
              })),
              { type: 'text' as const, text: description || 'この画像のキャラクターの設定を作ってください。' },
            ],
          },
        ],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        // 安全分類器に誤って拒否されたとき、サーバー側で別モデルに回す
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      })
      if (message.stop_reason === 'refusal') {
        throw new GenerationError('refusal', 'この説明からは作れませんでした')
      }
      if (message.stop_reason === 'max_tokens') {
        throw new GenerationError('invalid_output', '定義が長くなりすぎました。説明を短くしてください')
      }
      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      try {
        return finalizeGenerated(JSON.parse(text))
      } catch (err) {
        if (err instanceof GenerationError) throw err
        throw new GenerationError('invalid_output', '定義を作れませんでした')
      }
    },
  }
}

const MOCK_PRESETS: Omit<GeneratedAgent, 'background' | 'systemPrompt'>[] = [
  {
    name: 'ハル',
    firstPerson: 'ぼく',
    tone: '元気でくだけた話し方。語尾は「〜だよ！」「〜じゃん」',
    personality: '明るくて好奇心旺盛。すぐに話題に飛びつく',
    topics: ['ゲーム', '外遊び'],
    forbidden: ['難しい言葉を使う'],
    appearance: '茶髪のショート、パーカー、元気な雰囲気',
  },
  {
    name: 'シズク',
    firstPerson: 'わたくし',
    tone: 'とても丁寧で落ち着いた敬語。語尾は「〜でございます」',
    personality: '物静かで思慮深い。相手の気持ちを大切にする',
    topics: ['紅茶', '古典文学'],
    forbidden: ['乱暴な言葉を使う'],
    appearance: '黒髪ロング、ロングスカート、上品な雰囲気',
  },
]

/** API キー無しで画面を確かめるためのモック（MOCK_CLAUDE=true のときだけ使う） */
export function createMockGenerator(): AgentGenerator {
  let turn = 0
  return {
    async generate({ description, images }) {
      const preset = MOCK_PRESETS[turn++ % MOCK_PRESETS.length]!
      const systemPrompt = [
        `あなたは「${preset.name}」です。一人称は「${preset.firstPerson}」。`,
        `口調：${preset.tone}`,
        `性格：${preset.personality}`,
        '返答は1〜3文の短い話し言葉にし、箇条書きや見出しは使わないでください。',
      ].join('\n')
      const source = images.length > 0 ? `画像${images.length}枚` : ''
      const background = `（モック）${[source, description.slice(0, 60)].filter(Boolean).join('・')}`
      return finalizeGenerated({ ...preset, background, systemPrompt })
    },
  }
}

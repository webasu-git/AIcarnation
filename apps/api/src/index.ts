import { createApp } from './app'
import { createClaudeModel, createMockModel, type ChatModel } from './claude'
import { createClaudeGenerator, createMockGenerator, type AgentGenerator } from './generator'
import { createClaudeVoiceSuggester, createMockVoiceSuggester } from './voice'

let mockModel: ChatModel | null = null
let mockGenerator: AgentGenerator | null = null

export default createApp({
  getModel(env) {
    if (env.ANTHROPIC_API_KEY) return createClaudeModel(env.ANTHROPIC_API_KEY, env.CHAT_MODEL)
    if (env.MOCK_CLAUDE === 'true') return (mockModel ??= createMockModel())
    throw new Error('ANTHROPIC_API_KEY が設定されていません')
  },
  getGenerator(env) {
    if (env.ANTHROPIC_API_KEY) return createClaudeGenerator(env.ANTHROPIC_API_KEY, env.GENERATE_MODEL)
    if (env.MOCK_CLAUDE === 'true') return (mockGenerator ??= createMockGenerator())
    throw new Error('ANTHROPIC_API_KEY が設定されていません')
  },
  getVoiceSuggester(env) {
    // 声の推薦は軽い処理なので、会話と同じ低遅延のモデルを使う
    if (env.ANTHROPIC_API_KEY) return createClaudeVoiceSuggester(env.ANTHROPIC_API_KEY, env.CHAT_MODEL)
    if (env.MOCK_CLAUDE === 'true') return createMockVoiceSuggester()
    throw new Error('ANTHROPIC_API_KEY が設定されていません')
  },
})

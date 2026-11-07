import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  DEFAULT_VOICE,
  NO_VRM,
  withEmotionInstruction,
  type AgentDefinition,
  type AgentMissing,
  type AgentMotions,
  type AgentVoice,
  type AgentVrmRef,
  type GeneratedAgent,
} from '@aicarnation/shared'
import { createDefaultAgent } from '../agents/defaultAgent'
import {
  makeCharacterFile,
  parseCharacterFile,
  pruneMissing,
  resolveVoice,
  type CharacterFile,
} from '../agents/characterFile'
import { addDictWord, cachedEngineStyles, isEngineSampleEntry, listDictWords, parseEngineVoiceURI } from '../voice/engines'
import { deleteRemoteAgent, syncAgent } from '../api/agents'
import { deleteAgent, loadAgents, saveAgent } from '../db/agents'
import { clearMessages } from '../db/messages'
import { deleteVrmFile, getVrmFile } from '../db/vrmFiles'
import { getSetting, setSetting } from '../db/settings'

/**
 * ストアの中身は Vue のリアクティブなオブジェクトで、IndexedDB や structuredClone に渡せないため、
 * 保存・複製の前にプレーンなオブジェクトにする
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const syncQueues = new Map<string, Promise<void>>()

/**
 * D1 への同期はバックアップなので、失敗しても操作は止めない。
 * 同じエージェントへの保存と削除が追い越さないよう、エージェントごとに順番に送る
 */
function backup(id: string, task: () => Promise<void>) {
  const next = (syncQueues.get(id) ?? Promise.resolve())
    .then(task)
    .catch((err: unknown) => console.warn('エージェントの同期に失敗しました', err))
  syncQueues.set(id, next)
  void next.finally(() => {
    if (syncQueues.get(id) === next) syncQueues.delete(id)
  })
}

/** 読み込むキャラクターのファイルの大きさの上限（設定と辞書だけなので小さい） */
const MAX_CHARACTER_JSON_BYTES = 512 * 1024

export const useAgentsStore = defineStore('agents', () => {
  const agents = ref<AgentDefinition[]>([])
  const currentId = ref('')
  const current = computed(() => agents.value.find((a) => a.id === currentId.value) ?? agents.value[0] ?? null)

  async function persist(agent: AgentDefinition) {
    const data = plain(agent)
    await saveAgent(data)
    backup(data.id, () => syncAgent(data))
  }

  async function load() {
    agents.value = await loadAgents()
    if (agents.value.length === 0) {
      const first = createDefaultAgent(NO_VRM)
      await persist(first)
      agents.value = [first]
    }
    const saved = await getSetting('currentAgentId')
    currentId.value = agents.value.some((a) => a.id === saved) ? (saved as string) : (agents.value[0]?.id ?? '')
  }

  async function select(id: string) {
    if (!agents.value.some((a) => a.id === id)) return
    currentId.value = id
    await setSetting('currentAgentId', id)
  }

  /** 生成・入力した設定と見た目から新しいエージェントを作り、選択する */
  async function create(fields: GeneratedAgent, vrm: AgentVrmRef, voice: AgentVoice = DEFAULT_VOICE): Promise<AgentDefinition> {
    const now = new Date().toISOString()
    const agent: AgentDefinition = {
      ...fields,
      systemPrompt: withEmotionInstruction(fields.systemPrompt),
      id: crypto.randomUUID(),
      vrm,
      voice: { ...voice },
      createdAt: now,
      updatedAt: now,
    }
    await persist(agent)
    agents.value.push(agent)
    await select(agent.id)
    return agent
  }

  async function update(id: string, changes: Partial<Omit<AgentDefinition, 'id' | 'createdAt'>>) {
    const index = agents.value.findIndex((a) => a.id === id)
    const before = agents.value[index]
    if (!before) return
    const after: AgentDefinition = { ...before, ...changes, updatedAt: new Date().toISOString() }
    after.systemPrompt = withEmotionInstruction(after.systemPrompt)
    // 読み込んだキャラクターの足りない素材は、入れたものから消す
    const missing = pruneMissing(after)
    if (missing) after.missing = missing
    else delete after.missing
    await persist(after)
    agents.value[index] = after
    await releaseFiles(filesOf(before))
  }

  /**
   * 読み込んだキャラクターの「足りない素材」の案内を、種類ごとに消す（その素材を使わないことにしたとき）。
   * 動きの案内は、同じ名前のファイルを入れないと消えないので、使わない場合はここから消す
   */
  async function dismissMissing(id: string, key: keyof AgentMissing) {
    const agent = agents.value.find((a) => a.id === id)
    if (!agent?.missing?.[key]) return
    const { [key]: _removed, ...rest } = agent.missing
    await update(id, { missing: Object.keys(rest).length ? rest : undefined })
  }

  /** キャラクターが使っているファイル（VRM・動き・背景・アイコン）の id */
  function filesOf(agent: AgentDefinition): string[] {
    const ids = Object.values(agent.motions ?? {}).flatMap((list) => (list ?? []).map((m) => m.fileId))
    if (agent.vrm.source === 'local') ids.push(agent.vrm.ref)
    if (agent.backdrop && agent.backdrop.kind !== 'color') ids.push(agent.backdrop.fileId)
    if (agent.icon) ids.push(agent.icon.fileId)
    return ids
  }

  /** どのキャラクターも使わなくなったファイル（VRM・動き）を消す。動きのファイルは複製したキャラクターと共有するので、最後の1つが外れたときだけ */
  async function releaseFiles(ids: string[]) {
    const inUse = new Set(agents.value.flatMap(filesOf))
    for (const id of new Set(ids)) if (!inUse.has(id)) await deleteVrmFile(id).catch(() => undefined)
  }

  /** キャラクターの動きの割り当てを入れ替える（外したファイルは、ほかで使っていなければ消す） */
  async function setMotions(id: string, motions: AgentMotions) {
    await update(id, { motions })
  }

  async function duplicate(id: string) {
    const source = agents.value.find((a) => a.id === id)
    if (!source) return
    const now = new Date().toISOString()
    const copy: AgentDefinition = {
      ...plain(source),
      id: crypto.randomUUID(),
      name: `${source.name}（コピー）`,
      createdAt: now,
      updatedAt: now,
    }
    await persist(copy)
    agents.value.push(copy)
    await select(copy.id)
  }

  /** エージェントと、その会話履歴・使われなくなったVRMファイルを消す */
  async function remove(id: string) {
    const target = agents.value.find((a) => a.id === id)
    if (!target) return
    await deleteAgent(id)
    await clearMessages(id)
    agents.value = agents.value.filter((a) => a.id !== id)
    await releaseFiles(filesOf(target))
    backup(id, () => deleteRemoteAgent(id))

    if (agents.value.length === 0) {
      const first = createDefaultAgent(NO_VRM)
      await persist(first)
      agents.value = [first]
    }
    if (currentId.value === id) await select(agents.value[0]!.id)
  }

  /**
   * キャラクターを書き出す（設定だけ）。人格・声の設定・動きの割り当て（役とファイル名）・読みの辞書を入れ、
   * 3D モデル・動きのファイル・声のモデルは入れない
   */
  async function exportCharacter(id: string): Promise<{ filename: string; json: string } | null> {
    const agent = agents.value.find((a) => a.id === id)
    if (!agent) return null
    const vrmFileName = agent.vrm.source === 'local' ? ((await getVrmFile(agent.vrm.ref))?.name ?? null) : null
    const engine = parseEngineVoiceURI(agent.voice.voiceURI)
    const engineStyle = engine ? ((await cachedEngineStyles(engine.engine)).find((s) => s.styleId === engine.styleId) ?? null) : null
    const dictionary = await listDictWords()
      .then((words) => words.map(({ surface, pronunciation, accentType }) => ({ surface, pronunciation, accentType })))
      .catch(() => [])
    const file = makeCharacterFile(plain(agent), { vrmFileName, engineStyle, dictionary })
    return { filename: `${agent.name}.character.json`, json: JSON.stringify(file, null, 2) }
  }

  /**
   * 書き出したキャラクターを読み込み、新しいキャラクターとして足す。素材のファイルは入っていないので、
   * まだ入っていないもの（VRM・動き・声のモデル）を missing に覚え、入れたものから消す
   */
  /**
   * キャラクターの書き出しファイルを読み込む。読みの辞書は、書き出した PC の辞書がそのまま入っているので、
   * 黙って足さず、confirmWords で利用者に確かめてから、まだ無い言葉だけを足す（足さないなら何もしない）
   */
  async function importCharacter(
    text: string,
    confirmWords: (words: CharacterFile['dictionary']) => boolean = () => false,
  ): Promise<{ agent: AgentDefinition; needs: string[] }> {
    if (new TextEncoder().encode(text).byteLength > MAX_CHARACTER_JSON_BYTES) throw new Error('ファイルが大きすぎます')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('JSON として読み込めませんでした')
    }
    const file = parseCharacterFile(parsed)
    const { voice, missing: missingVoice } = resolveVoice(file.voice, await cachedEngineStyles('aivis'))
    const missing: AgentMissing = {}
    if (file.vrmFileName) missing.vrmFileName = file.vrmFileName
    if (file.motions.length) missing.motions = file.motions
    if (missingVoice) missing.voice = missingVoice
    // 背景の画像・動画は入っていないので、単色はそのまま、画像・動画は入れてもらう
    if (file.backdrop && file.backdrop.kind !== 'color') missing.backgroundFileName = file.backdrop.name
    if (file.icon) missing.icon = file.icon
    const now = new Date().toISOString()
    // 確かめた項目だけを取り出す（書き出しファイルに余計な項目があっても、そのまま保存しない）
    const c = file.character
    const agent: AgentDefinition = {
      name: c.name,
      firstPerson: c.firstPerson,
      tone: c.tone,
      personality: c.personality,
      background: c.background,
      topics: [...c.topics],
      forbidden: [...c.forbidden],
      appearance: c.appearance,
      systemPrompt: withEmotionInstruction(c.systemPrompt),
      id: crypto.randomUUID(),
      vrm: NO_VRM,
      voice,
      motions: {},
      ...(file.backdrop?.kind === 'color' ? { backdrop: { kind: 'color' as const, color: file.backdrop.color } } : {}),
      ...(file.steadyWaist === false ? { steadyWaist: false } : {}),
      ...(file.talkGestures === false ? { talkGestures: false } : {}),
      ...(Object.keys(missing).length ? { missing } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await persist(agent)
    agents.value.push(agent)
    await select(agent.id)

    const needs: string[] = []
    if (missing.vrmFileName) needs.push(`3D モデル（${missing.vrmFileName}）`)
    if (missing.voice) needs.push(`声のモデル（${missing.voice.speaker}・${missing.voice.style}）`)
    if (missing.motions) needs.push(`動きのファイル ${missing.motions.length} 個`)
    if (missing.backgroundFileName) needs.push(`背景の画像・動画（${missing.backgroundFileName}）`)
    if (missing.icon) needs.push(`アイコンの画像（${missing.icon.name}）`)
    // 以前の書き出しファイルに入っている、AivisSpeech の登録の例（担々麺）は足さない
    const dictionary = file.dictionary.filter((w) => !isEngineSampleEntry(w))
    const words = dictionary.length && confirmWords(dictionary) ? await addMissingWords(dictionary) : 0
    if (words === null) needs.push('読みの辞書（AivisSpeech を起動してから読み込み直していただくと入ります）')
    return { agent, needs }
  }

  /** 辞書に無い言葉だけを足す。足した数（AivisSpeech が起動していなければ null） */
  async function addMissingWords(words: CharacterFile['dictionary']): Promise<number | null> {
    if (words.length === 0) return 0
    try {
      const have = new Set((await listDictWords()).map((w) => w.surface))
      let added = 0
      for (const w of words) {
        if (have.has(w.surface)) continue
        await addDictWord(w)
        added++
      }
      return added
    } catch {
      return null
    }
  }

  return {
    agents,
    currentId,
    current,
    load,
    select,
    create,
    update,
    setMotions,
    duplicate,
    remove,
    exportCharacter,
    importCharacter,
    dismissMissing,
  }
})

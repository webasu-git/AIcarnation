import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  DEFAULT_VOICE,
  NO_VRM,
  normalizeAgentDefinition,
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
import { laterDelay, withRetry } from '../retry'

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

/** キャラクターの変更（id と作った日時は変えない） */
type AgentChanges = Partial<Omit<AgentDefinition, 'id' | 'createdAt'>>

export const useAgentsStore = defineStore('agents', () => {
  const agents = ref<AgentDefinition[]>([])
  const currentId = ref('')
  const current = computed(() => agents.value.find((a) => a.id === currentId.value) ?? agents.value[0] ?? null)

  /**
   * 保存できなかったこと（画面の上に知らせる）。
   * - agents：変更を保存できなかったキャラクターの id。変更は画面にも入れない（保存できた分だけを見せる）。そのキャラクターを次に保存できたら消す
   * - current：選んだキャラクター。画面は切り替えたまま、あとで保存し直す
   */
  const unsaved = ref<{ agents: string[]; current: boolean }>({ agents: [], current: false })

  async function persist(agent: AgentDefinition) {
    const data = plain(agent)
    try {
      await withRetry(() => saveAgent(data))
    } catch (err) {
      // 知らせるのは、一覧にあるキャラクターの変更だけ（新しく作る・複製するときの失敗は、呼び出し元が伝える。
      // 一覧に無い id を残すと、保存し直す道が無く、知らせが消えなくなる）
      if (agents.value.some((a) => a.id === data.id) && !unsaved.value.agents.includes(data.id)) unsaved.value.agents.push(data.id)
      throw err
    }
    unsaved.value.agents = unsaved.value.agents.filter((id) => id !== data.id)
    // バックアップには、前の版で入った値を今の決まりに直して送る（中継 API の検証で断られ続けないように）
    backup(data.id, () => syncAgent(normalizeAgentDefinition(data)))
  }

  async function load() {
    // 一覧と「どれを選んでいたか」は、両方読み終えてから同時に入れる。
    // 一覧だけ先に入れると、その間は先頭のキャラクターが選択中に見え、先頭の見た目・履歴・動きを読み始めてしまう
    // 保存先に一時的につながらないことがあるので、間を空けて読み直す。それでも読めなければ失敗を返す
    // （読めないのに「キャラクターが無い」とみなして既定のキャラクターを作ると、保存済みのキャラクターを上書きしてしまう）
    const [stored, saved] = (await withRetry(() => Promise.all([loadAgents(), getSetting('currentAgentId')])))!
    // 前の版で入った範囲外の値は、画面でも今の決まりに合う値で扱う（次に保存したときに直る）
    const list = stored.map(normalizeAgentDefinition)
    if (list.length === 0) {
      const first = createDefaultAgent(NO_VRM)
      await persist(first)
      list.push(first)
    }
    currentId.value = list.some((a) => a.id === saved) ? (saved as string) : (list[0]?.id ?? '')
    agents.value = list
  }

  let selectCount = 0
  let reselectTimer: ReturnType<typeof setTimeout> | null = null
  let reselectFailures = 0

  /** キャラクターを選ぶ。保存できなかったら知らせ、あとで保存し直す（途中で別のキャラクターを選んだら、古いほうはやめる） */
  async function select(id: string) {
    if (!agents.value.some((a) => a.id === id)) return
    currentId.value = id
    const mine = ++selectCount
    const isLatest = () => mine === selectCount
    try {
      await withRetry(() => setSetting('currentAgentId', id), isLatest)
      if (isLatest()) {
        unsaved.value.current = false
        reselectFailures = 0
      }
    } catch {
      if (!isLatest()) return
      unsaved.value.current = true
      // 保存し直しは、失敗が続くほど間を空ける（保存先が止まったままのとき、試し続けないように）
      reselectTimer ??= setTimeout(() => {
        reselectTimer = null
        if (unsaved.value.current) void select(currentId.value)
      }, laterDelay(reselectFailures++))
    }
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

  /** キャラクターごとの変更の列。保存のやり直しで待っている間の変更は、そのあとに順に行う（古い変更で新しい変更を上書きしないように） */
  const updating = new Map<string, Promise<unknown>>()
  /** 消している（消した）キャラクター。あとから入った変更で、保存し直さない */
  const removing = new Set<string>()

  /**
   * キャラクターを変える。changes に関数を渡すと、前の変更を保存し終えた時点の最新の中身から変更を作る
   * （今の中身をもとに作る変更（動きを1つ足すなど）は、関数で渡す。保存を待っている前の変更を消さないように）
   */
  function update(id: string, changes: AgentChanges | ((agent: AgentDefinition) => AgentChanges)): Promise<void> {
    // 消し始めたあとに頼まれた変更はしない。失敗を返して、呼び出し元に表示を戻させる（成功に見せない）。
    // 消し始める前に頼まれた変更は列に入っていて、削除はそれを待つ
    if (removing.has(id)) return Promise.reject(new Error('このキャラクターは削除しています'))
    const queued = (updating.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => applyUpdate(id, changes))
    updating.set(id, queued)
    void queued.finally(() => {
      if (updating.get(id) === queued) updating.delete(id)
    }).catch(() => undefined)
    return queued
  }

  async function applyUpdate(id: string, changes: AgentChanges | ((agent: AgentDefinition) => AgentChanges)) {
    // 前の変更を保存し終えてから、その時点の最新の中身に重ねる
    const before = agents.value.find((a) => a.id === id)
    if (!before) return
    const resolved = typeof changes === 'function' ? changes(before) : changes
    const after: AgentDefinition = { ...before, ...resolved, updatedAt: new Date().toISOString() }
    after.systemPrompt = withEmotionInstruction(after.systemPrompt)
    // 読み込んだキャラクターの足りない素材は、入れたものから消す
    const missing = pruneMissing(after)
    if (missing) after.missing = missing
    else delete after.missing
    await persist(after)
    // 保存を待っている間に一覧が変わっている（ほかのキャラクターを消したなど）ことがあるので、id で探して入れる
    const index = agents.value.findIndex((a) => a.id === id)
    if (index >= 0) agents.value[index] = after
    await releaseFiles(filesOf(before))
  }

  /**
   * 読み込んだキャラクターの「足りない素材」の案内を、種類ごとに消す（その素材を使わないことにしたとき）。
   * 動きの案内は、同じ名前のファイルを入れないと消えないので、使わない場合はここから消す
   */
  async function dismissMissing(id: string, key: keyof AgentMissing) {
    const agent = agents.value.find((a) => a.id === id)
    if (!agent?.missing?.[key]) return
    await update(id, (latest) => {
      const { [key]: _removed, ...rest } = latest.missing ?? {}
      return { missing: Object.keys(rest).length ? rest : undefined }
    })
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

  /** キャラクターの動きの割り当てを変える。edit は、その時点の最新の割り当てから新しい割り当てを作る（外したファイルは、ほかで使っていなければ消す） */
  async function setMotions(id: string, edit: (motions: AgentMotions) => AgentMotions) {
    await update(id, (latest) => ({ motions: edit(latest.motions ?? {}) }))
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

  /** 削除の列（重ねて消すと、どちらも「一覧が空」とみなして既定のキャラクターを 2 体作るので、1 つずつ消す）と、消している途中のもの */
  let removeChain: Promise<unknown> = Promise.resolve()
  const removals = new Map<string, Promise<void>>()

  /** エージェントと、その会話履歴・使われなくなったVRMファイルを消す。同じキャラクターを重ねて消すと、同じ削除の結果を返す */
  function remove(id: string): Promise<void> {
    const inProgress = removals.get(id)
    if (inProgress) return inProgress
    if (!agents.value.some((a) => a.id === id) || removing.has(id)) return Promise.resolve()
    // 頼まれた時点で「消している」印を付ける（このあとに頼まれた変更は保存しない）
    removing.add(id)
    const removal = removeChain.catch(() => undefined).then(() => removeNow(id))
    removeChain = removal
    removals.set(id, removal)
    void removal.finally(() => removals.delete(id)).catch(() => undefined)
    return removal
  }

  async function removeNow(id: string) {
    const target = agents.value.find((a) => a.id === id)
    if (!target) return
    // 保存を待っている変更が済むのを待って消す（あとから保存が成功して、消したキャラクターが戻らないように）
    try {
      await updating.get(id)?.catch(() => undefined)
      await deleteAgent(id)
    } catch (err) {
      // 消せなかった：印を外して、変更も削除も、もう一度できるようにする
      removing.delete(id)
      throw err
    }
    // キャラクターはもう消えたので、履歴を消せなくても一覧からは外す（残った履歴は、同じ id が使われないので表に出ない）
    await clearMessages(id).catch(() => undefined)
    agents.value = agents.value.filter((a) => a.id !== id)
    unsaved.value.agents = unsaved.value.agents.filter((x) => x !== id)
    await releaseFiles(filesOf(target))
    backup(id, () => deleteRemoteAgent(id))

    if (agents.value.length === 0) {
      // 最後の 1 体を消したら、既定のキャラクターを作る。保存できなくても、削除はできているので失敗にしない
      // （保存できなかった既定のキャラクターは、次に開いたときに作り直される）
      const first = createDefaultAgent(NO_VRM)
      await persist(first).catch(() => undefined)
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
    unsaved,
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

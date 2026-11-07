import { defineStore } from 'pinia'
import { computed, markRaw, ref, shallowRef } from 'vue'
import {
  DEFAULT_VOICE,
  MAX_CHAT_MESSAGES,
  type AgentDefinition,
  type AgentVoice,
  type BridgeEvent,
  type ChatMessage,
  cleanPromptText,
  type Emotion,
} from '@aicarnation/shared'
import { ApiError } from '../api/client'
import { streamChat } from '../chat/api'
import { EmotionStreamParser, lastEmotion, stripEmotionTags } from '../chat/emotionParser'
import { ReplyPerformer, type AvatarControl, type Speaker } from '../chat/performer'
import { clearMessages, loadMessages, saveMessage, type MessageRecord } from '../db/messages'
import { isSpeechSupported, prefetchSpeech, speak } from '../voice/speech'
import type { ActivityEvent } from '../behavior/reactions'
import type { MotionState } from '../vrm/idle'
import { useAgentsStore } from './agents'
import { useSettingsStore } from './settings'

export interface DisplayMessage {
  role: ChatMessage['role']
  text: string
}

/** Claude 連携で吹き出しに残すやり取りの数 */
const BRIDGE_LOG_SIZE = 6

/** 送る履歴を直近20往復（＋今回の発言）に絞る。先頭はユーザーの発言にそろえる */
function recentHistory(records: MessageRecord[]): ChatMessage[] {
  const recent = records.slice(-MAX_CHAT_MESSAGES)
  const firstUser = recent.findIndex((r) => r.role === 'user')
  return recent.slice(Math.max(firstUser, 0)).map(({ role, content }) => ({ role, content }))
}

export const useChatStore = defineStore('chat', () => {
  const agents = useAgentsStore()
  const settings = useSettingsStore()
  /** 表示中の履歴がどのエージェントのものか */
  const agentId = ref('')
  const records = ref<MessageRecord[]>([])
  /** 文字送り中の応答 */
  const pendingReply = ref<string | null>(null)
  /** 応答の受信から演技が終わるまで */
  const sending = ref(false)
  /** 応答を受信している間。この間は次の発言を送れない */
  const streaming = ref(false)
  const error = ref('')

  const avatar = shallowRef<AvatarControl | null>(null)
  let getWindow: () => Window = () => window

  const messages = computed<DisplayMessage[]>(() => {
    const list = records.value.map((r) => ({
      role: r.role,
      text: r.role === 'assistant' ? stripEmotionTags(r.content) : r.content,
    }))
    if (pendingReply.value !== null) list.push({ role: 'assistant', text: pendingReply.value })
    return list
  })

  function attachAvatar(control: AvatarControl, windowGetter: () => Window) {
    avatar.value = markRaw(control)
    getWindow = windowGetter
  }

  /** エージェントを切り替えたときに、そのエージェントの履歴を読み込む */
  async function load(id: string) {
    agentId.value = id
    error.value = ''
    const loaded = await loadMessages(id)
    // 読み込み中に別のエージェントへ切り替わっていたら捨てる
    if (agentId.value === id) records.value = loaded
  }

  async function append(id: string, role: ChatMessage['role'], content: string, emotion: Emotion | null) {
    const record: MessageRecord = {
      agentId: id,
      seq: (records.value.at(-1)?.seq ?? 0) + 1,
      role,
      content,
      emotion,
      createdAt: new Date().toISOString(),
    }
    records.value.push(record)
    await saveMessage(record)
  }

  /**
   * 文字送り・口パク・読み上げ（音声オンのとき）をする演者を作る。
   * mayVoice が偽なら声は出さず、文字送りと口パクだけにする
   */
  function createPerformer(
    control: AvatarControl,
    agentVoice: AgentVoice,
    onText: (ch: string) => void,
    mayVoice: () => boolean = () => true,
  ) {
    const voice = { ...agentVoice }
    const speaker: Speaker = {
      rate: voice.rate,
      speak: (sentence, emotion) =>
        settings.voiceEnabled && mayVoice() && isSpeechSupported() ? speak(sentence, voice, emotion) : null,
      prefetch: (sentence, emotion) => prefetchSpeech(sentence, voice, emotion),
    }
    return new ReplyPerformer(control, onText, getWindow, speaker)
  }

  /** 返事を話し終えてから、感情の表情を普段の顔に戻すまでの時間 */
  const FACE_HOLD_MS = 1500
  let faceTimer: number | undefined

  /**
   * 話し終えたら、少し余韻を残してから普段の顔に戻す。
   * 笑顔（目を細める）や驚き（口を開ける）などの表情は、次の感情タグが来るまで残ってしまうため
   */
  function relaxFace(control: AvatarControl) {
    const win = getWindow()
    win.clearTimeout(faceTimer)
    faceTimer = win.setTimeout(() => control.setEmotion('neutral'), FACE_HOLD_MS)
  }

  /** 新しいやり取りが始まったら、普段の顔に戻す予定は取り消す（その場で戻す） */
  function cancelRelaxFace() {
    getWindow().clearTimeout(faceTimer)
  }

  /** 会話の出来事（発言・Claude Code の合図）を知りたい相手。ひとりで過ごす行動の監督が使う */
  const activityListeners = new Set<(event: ActivityEvent) => void>()
  function onActivity(listener: (event: ActivityEvent) => void): () => void {
    activityListeners.add(listener)
    return () => activityListeners.delete(listener)
  }
  function notifyActivity(event: ActivityEvent) {
    for (const listener of activityListeners) listener(event)
  }

  /** 演技中（文字送り・読み上げ）の応答。次の入力が来たら止める */
  let activePerformer: ReplyPerformer | null = null
  let activeTask: Promise<void> | null = null

  /** 文字送り・読み上げを止める。応答の受信が終わっていれば、全文が履歴に残る */
  async function stopPerforming() {
    activePerformer?.cancel()
    if (activeTask) await activeTask
  }

  async function send(text: string) {
    const content = text.trim()
    if (!content || streaming.value) return
    notifyActivity({ type: 'send' })
    // 読み上げ中に次の入力があれば止める
    await stopPerforming()

    const control = avatar.value
    const agent = agents.current
    if (!control || !agent || agent.id !== agentId.value) return
    const task = respond(control, agent, content)
    activeTask = task
    await task
    if (activeTask === task) activeTask = null
  }

  async function respond(control: AvatarControl, agent: AgentDefinition, content: string) {
    sending.value = true
    streaming.value = true
    error.value = ''
    cancelRelaxFace()
    control.setEmotion('neutral')
    // 話しかけられたらうなずいて、返事が届くまで考える姿勢にする
    control.nod()
    control.setMotion('thinking')
    await append(agent.id, 'user', content, null)

    const parser = new EmotionStreamParser()
    let raw = ''
    pendingReply.value = ''
    const performer = createPerformer(control, agent.voice, (ch) => {
      pendingReply.value = (pendingReply.value ?? '') + ch
    })
    activePerformer = performer

    try {
      await streamChat(
        { agentId: agent.id, systemPrompt: agent.systemPrompt, messages: recentHistory(records.value) },
        {
          onDelta(delta) {
            if (!raw) control.setMotion('speaking')
            raw += delta
            performer.enqueue(parser.push(delta))
          },
        },
      )
      streaming.value = false
      performer.enqueue(parser.flush())
      await performer.finish()
      await append(agent.id, 'assistant', raw, lastEmotion(raw))
    } catch (err) {
      performer.cancel()
      control.setEmotion('sad')
      error.value = err instanceof ApiError ? err.message : '予期しないエラーが発生しました'
    } finally {
      control.setMotion('idle')
      relaxFace(control)
      activePerformer = null
      pendingReply.value = null
      streaming.value = false
      sending.value = false
    }
  }

  // --- Claude 連携 ---
  /** Claude Code とのやり取りのうち、アバターの吹き出しに出す直近のもの（保存しない） */
  const bridgeLog = ref<DisplayMessage[]>([])
  /** 文字送り中の、Claude Code の返答の要約 */
  const bridgePending = ref<string | null>(null)
  /** 「考え中」「ファイルを書き換えています」など、Claude Code の今の様子 */
  const bridgeStatus = ref('')

  const bridgeMessages = computed<DisplayMessage[]>(() =>
    bridgePending.value === null ? bridgeLog.value : [...bridgeLog.value, { role: 'assistant', text: bridgePending.value }],
  )

  function pushBridgeLog(message: DisplayMessage) {
    bridgeLog.value = [...bridgeLog.value, message].slice(-BRIDGE_LOG_SIZE)
  }

  /**
   * 画面が複数開いているとき、声を出すのはこの画面か（同梱サーバー・開発サーバーが決める）。
   * 声を出さない画面も、表情・口パク・吹き出しは同じように動かす
   */
  let bridgeSpeaker = true
  function setBridgeSpeaker(value: boolean) {
    bridgeSpeaker = value
  }

  /** 「聞いている」から「考えている」に移るまでの時間 */
  const LISTEN_TO_THINK_MS = 1200
  let thinkTimer: number | undefined

  /** Claude Code の mod から届いた合図に合わせて、アバターを反応させる */
  async function handleBridgeEvent(event: BridgeEvent) {
    const control = avatar.value
    if (!control) return
    const win = getWindow()
    // 出来事の知らせは、合図の処理（前の読み上げを止めるなど）を済ませてから出す。
    // 知らせを受けて話し始めた反応（「おかえり」など）が、すぐ止められないように
    if (event.type === 'notice') {
      notifyActivity(event)
      return
    }
    win.clearTimeout(thinkTimer)
    switch (event.type) {
      case 'listening':
        // 話しかけられたら、前の返答の読み上げはやめて、うなずいて聞く。少ししたら考える姿勢に移る
        await stopPerforming()
        {
          // 貼り付けの囲みや内部メモのタグを外し、文章だけを吹き出しに出す
          const text = cleanPromptText(event.text)
          if (text) pushBridgeLog({ role: 'user', text })
        }
        bridgeStatus.value = '考え中'
        cancelRelaxFace()
        control.setEmotion('neutral')
        control.nod()
        control.setMotion('listening')
        thinkTimer = win.setTimeout(() => control.setMotion('thinking'), LISTEN_TO_THINK_MS)
        notifyActivity(event)
        return
      case 'working':
        bridgeStatus.value = event.label
        // 要約を作っている間は考える姿勢、ツールを使っている間は作業の姿勢
        if (!activePerformer) control.setMotion(event.label === 'まとめています' ? 'thinking' : 'working')
        notifyActivity(event)
        return
      case 'idle':
        bridgeStatus.value = ''
        if (!activePerformer) control.setMotion('idle')
        notifyActivity(event)
        return
      case 'reply': {
        notifyActivity(event)
        await stopPerforming()
        bridgeStatus.value = ''
        const task = performBridgeReply(control, event.text)
        activeTask = task
        await task
        if (activeTask === task) activeTask = null
      }
    }
  }

  /** Claude Code の今の様子に合った姿勢（作業中・要約中・待機） */
  function motionForStatus(): MotionState {
    if (!bridgeStatus.value) return 'idle'
    return bridgeStatus.value === 'まとめています' || bridgeStatus.value === '考え中' ? 'thinking' : 'working'
  }

  /**
   * 出来事への反応や、ひとりで過ごすときの独り言（台詞帳の一言・感情タグ付き）を話す。
   * 返答を話している最中や、自分で話しかけて返事を待っている間は話さず false を返す。
   * Claude Code が作業している間は話してよく、話し終えたら作業の姿勢に戻る
   */
  /** 反応の台詞を話している間 */
  const reacting = ref(false)

  function performReaction(raw: string): boolean {
    const control = avatar.value
    if (!control || sending.value || activeTask || streaming.value) return false
    const task = performReactionTask(control, raw)
    activeTask = task
    void task.finally(() => {
      if (activeTask === task) activeTask = null
    })
    return true
  }

  async function performReactionTask(control: AvatarControl, raw: string) {
    const inBridge = settings.bridgeEnabled
    sending.value = true
    reacting.value = true
    cancelRelaxFace()
    control.setMotion('speaking')
    const show = (ch: string) => {
      if (inBridge) bridgePending.value = (bridgePending.value ?? '') + ch
      else pendingReply.value = (pendingReply.value ?? '') + ch
    }
    if (inBridge) bridgePending.value = ''
    else pendingReply.value = ''
    const performer = createPerformer(control, agents.current?.voice ?? DEFAULT_VOICE, show, () => !inBridge || bridgeSpeaker)
    activePerformer = performer
    const parser = new EmotionStreamParser()
    performer.enqueue([...parser.push(raw), ...parser.flush()])
    try {
      await performer.finish()
    } finally {
      activePerformer = null
      control.setMotion(motionForStatus())
      relaxFace(control)
      if (inBridge) {
        pushBridgeLog({ role: 'assistant', text: stripEmotionTags(raw) })
        bridgePending.value = null
      } else {
        pendingReply.value = null
      }
      sending.value = false
      reacting.value = false
    }
  }

  /**
   * 会話している最中か（返事を待っている・話している・Claude Code が作業している）。
   * 出来事への反応や独り言を話しているだけのときは、会話として数えない
   */
  const conversing = computed(() => (sending.value && !reacting.value) || streaming.value || bridgeStatus.value !== '')

  async function performBridgeReply(control: AvatarControl, raw: string) {
    sending.value = true
    bridgePending.value = ''
    cancelRelaxFace()
    control.setMotion('speaking')
    const performer = createPerformer(
      control,
      agents.current?.voice ?? DEFAULT_VOICE,
      (ch) => {
        bridgePending.value = (bridgePending.value ?? '') + ch
      },
      () => bridgeSpeaker,
    )
    activePerformer = performer
    const parser = new EmotionStreamParser()
    performer.enqueue([...parser.push(raw), ...parser.flush()])
    try {
      await performer.finish()
    } finally {
      control.setMotion('idle')
      relaxFace(control)
      pushBridgeLog({ role: 'assistant', text: stripEmotionTags(raw) })
      activePerformer = null
      bridgePending.value = null
      sending.value = false
    }
  }

  async function clear() {
    await stopPerforming()
    if (!agentId.value) return
    await clearMessages(agentId.value)
    records.value = []
    error.value = ''
    avatar.value?.setEmotion('neutral')
  }

  return {
    messages,
    sending,
    streaming,
    error,
    attachAvatar,
    load,
    send,
    stopPerforming,
    clear,
    bridgeMessages,
    bridgeStatus,
    handleBridgeEvent,
    setBridgeSpeaker,
    onActivity,
    performReaction,
    conversing,
  }
})

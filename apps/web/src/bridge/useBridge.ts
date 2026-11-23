import { onBeforeUnmount, ref, watch } from 'vue'
import { parseBridgeEvent, type BridgePersona } from '@aicarnation/shared'
import { useAgentsStore } from '../stores/agents'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { IS_COMPANION, companionHeaders, distrustCompanionServer, verifyCompanionServer, withToken } from '../runtime'

export type BridgeConnection = 'off' | 'connecting' | 'connected' | 'error'

/** 同梱版で、つなぎ直しを試す間隔 */
const RECONNECT_MS = 3000

/**
 * Claude 連携。オンの間、開発サーバーのブリッジ（/bridge/stream）を購読し、
 * 届いた合図でアバターを反応させる。選択中のエージェントの人柄はブリッジに渡し、
 * mod が返答を要約するときの口調に使う。
 */
export function useBridge() {
  const settings = useSettingsStore()
  const agents = useAgentsStore()
  const chat = useChatStore()
  const connection = ref<BridgeConnection>('off')
  let source: EventSource | null = null
  /** つなぎ直しの予約（同梱版）と、つなぐ処理の世代（古い処理の続きを捨てるための番号） */
  let retryTimer: number | undefined
  let generation = 0

  function disconnect() {
    generation++
    window.clearTimeout(retryTimer)
    source?.close()
    source = null
    connection.value = 'off'
  }

  /** 同梱版：少し待ってから、つなぎ先を確かめ直してつなぐ */
  function retryLater() {
    window.clearTimeout(retryTimer)
    retryTimer = window.setTimeout(() => void connect(), RECONNECT_MS)
  }

  async function connect() {
    disconnect()
    const mine = generation
    connection.value = 'connecting'
    if (IS_COMPANION) {
      // 同梱版：つなぐ前に、相手が本物の同梱サーバーかを確かめる。EventSource は合言葉を URL に付けて送るので、
      // 確かめずにつなぐと、サーバーが止まっている間にポートを取ったほかのプログラムに、合言葉を渡してしまう
      const ok = await verifyCompanionServer()
      if (mine !== generation) return
      if (!ok) {
        connection.value = 'error'
        retryLater()
        return
      }
    }
    source = new EventSource(withToken('/bridge/stream'))
    source.onopen = () => {
      connection.value = 'connected'
      void sendPersona()
    }
    source.onerror = () => {
      connection.value = 'error'
      if (!IS_COMPANION) return // 開発版：EventSource が自動でつなぎ直す
      // 同梱版：自動のつなぎ直しはさせない（合言葉付きの URL を、確かめていない相手に送らないため）。
      // 確かめ直すまで、ほかのリクエストにも合言葉を付けない
      source?.close()
      source = null
      distrustCompanionServer()
      retryLater()
    }
    // 画面が複数開いているときは、サーバーが決めた1つの画面だけが声を出す
    source.addEventListener('role', (e) => {
      try {
        const role = JSON.parse((e as MessageEvent<string>).data) as { speaker?: unknown }
        chat.setBridgeSpeaker(role.speaker !== false)
      } catch {
        // 壊れた知らせは捨てる
      }
    })
    source.addEventListener('bridge', (e) => {
      try {
        const event = parseBridgeEvent(JSON.parse((e as MessageEvent<string>).data))
        if (event) void chat.handleBridgeEvent(event)
      } catch {
        // 壊れた合図は捨てる
      }
    })
  }

  async function sendPersona() {
    const a = agents.current
    if (!a || !settings.bridgeEnabled) return
    const persona: BridgePersona = {
      name: a.name,
      firstPerson: a.firstPerson,
      tone: a.tone,
      personality: a.personality,
    }
    await fetch('/bridge/persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-aicarnation-bridge': '1', ...companionHeaders() },
      body: JSON.stringify(persona),
    }).catch(() => undefined)
  }

  watch(
    () => settings.bridgeEnabled,
    (enabled) => (enabled ? void connect() : disconnect()),
    { immediate: true },
  )
  // エージェントを切り替えたら、要約の口調もそのエージェントにする
  watch(
    () => agents.current?.id,
    () => {
      if (connection.value === 'connected') void sendPersona()
    },
  )

  onBeforeUnmount(disconnect)

  return { connection }
}

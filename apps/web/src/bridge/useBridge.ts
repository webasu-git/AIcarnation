import { onBeforeUnmount, ref, watch } from 'vue'
import { parseBridgeEvent, type BridgePersona } from '@aicarnation/shared'
import { useAgentsStore } from '../stores/agents'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { companionHeaders, withToken } from '../runtime'

export type BridgeConnection = 'off' | 'connecting' | 'connected' | 'error'

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

  function disconnect() {
    source?.close()
    source = null
    connection.value = 'off'
  }

  function connect() {
    disconnect()
    connection.value = 'connecting'
    source = new EventSource(withToken('/bridge/stream'))
    source.onopen = () => {
      connection.value = 'connected'
      void sendPersona()
    }
    // EventSource は切れても自動でつなぎ直す。その間はエラー表示にする
    source.onerror = () => {
      connection.value = 'error'
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
    (enabled) => (enabled ? connect() : disconnect()),
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

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { MAX_MESSAGE_CHARS } from '@aicarnation/shared'
import type { BridgeConnection } from '../bridge/useBridge'
import { barNotice, notify } from '../notice'
import { useAgentsStore } from '../stores/agents'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { engineStatus, parseEngineVoiceURI } from '../voice/engines'
import { useVoiceLabel } from '../voice/useVoiceLabel'
import { isSpeechSupported, voiceNotice } from '../voice/speech'
import { browserRecognitionLang, isRecognitionSupported, startRecognition } from '../voice/recognition'
import VolumeControl from './VolumeControl.vue'

const props = defineProps<{
  /** Claude 連携のつながり具合（つながっていないときだけバーに出す） */
  connection: BridgeConnection
}>()

const chat = useChatStore()
const settings = useSettingsStore()
const agents = useAgentsStore()
const speechSupported = isSpeechSupported()
const recognitionSupported = isRecognitionSupported()
const input = ref('')
const log = ref<HTMLElement | null>(null)

// --- 音声入力 ---
const listening = ref(false)
const micError = ref('')
let recognition: { stop(): void } | null = null

async function toggleMic() {
  if (listening.value) {
    recognition?.stop()
    return
  }
  micError.value = ''
  // 読み上げ中ならやめる（自分の声を拾わないように、また次の入力で止める）
  await chat.stopPerforming()
  listening.value = true
  recognition = startRecognition(browserRecognitionLang(), {
    onInterim: (text) => {
      input.value = text
    },
    onFinal: (text) => {
      input.value = ''
      void chat.send(text)
    },
    onError: (message) => {
      micError.value = message
    },
    onEnd: () => {
      listening.value = false
      recognition = null
    },
  })
}

// --- 吹き出し（字幕） ---
/** 話し終えてから吹き出しを消すまでの時間（「最新だけ」のとき） */
const CAPTION_HIDE_MS = 8000
const captionHidden = ref(false)
let hideTimer: number | undefined

const allMessages = computed(() => (settings.bridgeEnabled ? chat.bridgeMessages : chat.messages))

/**
 * アバターが隠れないよう、出す吹き出しを絞る。
 * - 最新だけ：直近の1往復（あなたの最後の発言と、それへの返事）。話し終えて少したったら消す
 * - すべて：直近6件
 * - なし：出さない
 */
const recent = computed(() => {
  const list = allMessages.value
  let start = list.length
  if (settings.captionMode === 'all') start = list.length - 6
  else if (settings.captionMode === 'latest' && !captionHidden.value) {
    let lastUser = list.length - 1
    while (lastUser >= 0 && list[lastUser]?.role !== 'user') lastUser--
    start = Math.max(lastUser, list.length - 2)
  }
  // やり取りの通し番号を目印にする（文字送り中の返事と、読み終えて残る返事は同じ番号になる）
  start = Math.max(start, 0)
  return list.slice(start).map((m, i) => ({ ...m, key: start + i }))
})

/** 何か話している・考えている間は吹き出しを出し、落ち着いたら消す */
const busy = computed(() => chat.sending || Boolean(chat.bridgeStatus))

watch(
  () => [allMessages.value.map((m) => m.text).join('\n'), busy.value] as const,
  async ([, isBusy]) => {
    window.clearTimeout(hideTimer)
    captionHidden.value = false
    if (!isBusy) hideTimer = window.setTimeout(() => (captionHidden.value = true), CAPTION_HIDE_MS)
    await nextTick()
    log.value?.scrollTo({ top: log.value.scrollHeight })
    // 「最新だけ」では返事の吹き出しの高さに上限があるので、文字送りで次の行に進んだら吹き出しの中も追いかける
    const bubbles = log.value?.querySelectorAll<HTMLElement>('.bubble.assistant')
    const last = bubbles?.[bubbles.length - 1]
    if (last) last.scrollTop = last.scrollHeight
  },
)

// --- 小窓の下のバーの文字 ---
/** 選んでいる声の名前（AivisSpeech の話者の一覧から引く） */
const { label: voiceLabel } = useVoiceLabel(() => agents.current?.voice.voiceURI ?? '')

/** 声の様子。読み上げのオン・オフ、使っている声、エンジンの起動の様子 */
const voiceStatus = computed(() => {
  if (!speechSupported) return ''
  if (!settings.voiceEnabled) return '読み上げ：オフ'
  const engine = parseEngineVoiceURI(agents.current?.voice.voiceURI ?? '')
  if (!engine) return '声：ブラウザの声'
  switch (engineStatus[engine.engine]) {
    case 'warming':
      return 'AivisSpeech を起動しています…'
    case 'down':
      return 'AivisSpeech に接続できません（ブラウザの声でお話しします）'
    default:
      return `声：${voiceLabel.value}`
  }
})

const CONNECTION_TEXT: Partial<Record<BridgeConnection, string>> = {
  connecting: 'Claude に接続しています…',
  error: 'Claude に接続できません',
}

/** バーに出す文字：知らせ → つながらない → 声の切り替えの知らせ → 声の様子 の順 */
const barText = computed(
  () => barNotice.value || CONNECTION_TEXT[props.connection] || (settings.voiceEnabled && voiceNotice.value) || voiceStatus.value,
)

// 設定を変えたら、何に変わったかを少しの間バーに出す（設定画面から変えたときも）
watch(
  () => settings.voiceEnabled,
  (on) => settings.loaded && notify(on ? '読み上げ：オン' : '読み上げ：オフ'),
)
watch(
  () => settings.volume,
  (v) => settings.loaded && notify(`音量 ${Math.round(v * 100)}%`),
)
watch(
  () => settings.captionMode,
  (mode) => settings.loaded && notify({ latest: '吹き出し：最新だけ', all: '吹き出し：すべて', off: '吹き出し：なし' }[mode]),
)

/** 小窓の中の 💬 ボタン：吹き出しを出す（最新だけ）／出さない を切り替える */
function toggleCaptions() {
  settings.captionMode = settings.captionMode === 'off' ? 'latest' : 'off'
}

function submit() {
  const text = input.value
  if (!text.trim() || chat.streaming) return
  input.value = ''
  void chat.send(text)
}

function onKeydown(e: KeyboardEvent) {
  // 変換確定の Enter では送らない
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
}
</script>

<template>
  <div class="chat" :class="`captions-${settings.captionMode}`">
    <div ref="log" class="log">
      <p v-for="m in recent" :key="m.key" class="bubble" :class="m.role">{{ m.text }}</p>
      <template v-if="settings.bridgeEnabled">
        <p v-if="chat.bridgeStatus" class="status">
          <span class="dots" aria-hidden="true" />{{ chat.bridgeStatus }}
        </p>
      </template>
      <template v-else>
        <p v-if="chat.error" class="bubble error">{{ chat.error }}</p>
        <p v-if="micError" class="bubble error">{{ micError }}</p>
      </template>
      <p v-if="voiceNotice && settings.voiceEnabled" class="status">{{ voiceNotice }}</p>
    </div>
    <div v-if="settings.bridgeEnabled" class="bridge-bar">
      <VolumeControl v-if="speechSupported" />
      <span class="bar-label" :title="barText">{{ barText }}</span>
      <button
        type="button"
        class="voice"
        :class="{ off: settings.captionMode === 'off' }"
        :aria-pressed="settings.captionMode !== 'off'"
        :title="settings.captionMode === 'off' ? '吹き出し：なし' : '吹き出し：表示'"
        @click="toggleCaptions"
      >
        💬
      </button>
    </div>
    <form v-else class="input" @submit.prevent="submit">
      <button
        v-if="recognitionSupported"
        type="button"
        class="mic"
        :class="{ listening }"
        :disabled="chat.streaming && !listening"
        :aria-pressed="listening"
        :title="listening ? '聞き取りをやめる' : '声で話しかける'"
        @click="toggleMic"
      >
        🎤
      </button>
      <VolumeControl v-if="speechSupported" />
      <textarea
        v-model="input"
        rows="1"
        :maxlength="MAX_MESSAGE_CHARS"
        :placeholder="listening ? '聞き取っています…' : 'メッセージを入力…'"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="voice"
        :class="{ off: settings.captionMode === 'off' }"
        :aria-pressed="settings.captionMode !== 'off'"
        :title="settings.captionMode === 'off' ? '吹き出し：なし' : '吹き出し：表示'"
        @click="toggleCaptions"
      >
        💬
      </button>
      <button type="submit" :disabled="chat.streaming || !input.trim()">送信</button>
    </form>
  </div>
</template>

<style scoped>
/*
 * 吹き出しと入力欄は3Dの背景に重なるので、ダークモードでも明るい地に濃い文字で固定する。
 * 大きさは画面（ステージ）の大きさに合わせて変える：吹き出しと下のバーの文字の大きさを
 * 幅（cqw）と高さ（vh。小窓では小窓の高さ）から決め、中の余白・ボタンはすべて em でそれに比例させる
 */
.chat {
  color: #1e2030;
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5em;
  padding: 0.55em;
  pointer-events: none;
  container-type: inline-size;
  font-size: 16px;
}
/*
 * 吹き出し：幅の 4%（高さの 3.2% まで）。510×830 の小窓で約 20px
 * 下のバー・ボタン：幅の 5.2%（高さの 4.2% まで）。同じ小窓で約 27px（バーの高さ 約 70px）
 * 横長・縦長のどちらでも大きくなりすぎないよう、幅と高さの小さい方で決め、上下も決めておく
 */
.log {
  font-size: clamp(15px, min(4cqw, 3.2vh), 28px);
}
.bridge-bar,
.input {
  font-size: clamp(16px, min(5.2cqw, 4.2vh), 34px);
}
.log {
  display: flex;
  flex-direction: column;
  gap: 0.4em;
  max-height: 38vh;
  overflow-y: auto;
  pointer-events: auto;
  scrollbar-width: thin;
}
.bubble {
  margin: 0;
  max-width: 85%;
  padding: 0.4em 0.7em;
  border-radius: 0.8em;
  font-size: 1em;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.12);
}
/* 「最新だけ」：アバターが見えるよう、吹き出しを字幕のように短くする */
.captions-latest .log {
  max-height: 30vh;
}
.captions-latest .bubble {
  line-height: 1.4;
}
.captions-latest .bubble.user {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  opacity: 0.85;
}
.captions-latest .bubble.assistant {
  max-height: 4.4em;
  overflow-y: auto;
  scrollbar-width: none;
}
/* 新しい吹き出しはふわっと出す（消えるときはすぐ消して、重ならないようにする） */
.bubble {
  animation: bubble-in 0.35s ease-out;
}
@keyframes bubble-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.bubble.assistant {
  align-self: flex-start;
  background: rgb(255 255 255 / 0.92);
}
.bubble.user {
  align-self: flex-end;
  background: rgb(59 130 246 / 0.92);
  color: #fff;
}
.bubble.error {
  align-self: flex-start;
  background: #fde8e8;
  color: var(--danger);
}
.input {
  display: flex;
  gap: 0.4em;
  pointer-events: auto;
}
.status {
  align-self: flex-start;
  margin: 0;
  padding: 0.3em 0.7em;
  border-radius: 0.8em;
  font-size: 0.9em;
  color: #6b7085;
  background: rgb(255 255 255 / 0.85);
}
/* 考え中を表す3つの点 */
.dots::before {
  content: '…';
  display: inline-block;
  margin-right: 0.3em;
  animation: pulse 1.2s ease-in-out infinite;
}
/* 幅が狭いときは折り返さず、省略して1行に収める */
.bar-label {
  flex: 1;
  min-width: 0;
  padding-left: 0.4em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bridge-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5em;
  padding: 0.3em;
  border-radius: 0.6em;
  color: #6b7085;
  background: rgb(255 255 255 / 0.85);
  pointer-events: auto;
}
.chat button {
  font-size: 1em;
  padding: 0.4em 0.6em;
  border-radius: 0.6em;
  line-height: 1.2;
}
.voice,
.mic {
  text-align: center;
  min-width: 2.4em;
}
.mic.listening {
  background: var(--danger);
  border-color: var(--danger);
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.6;
  }
}
.voice.off {
  opacity: 0.6;
}
.chat button {
  border-color: #dfe1ea;
  background: rgb(255 255 255 / 0.95);
}
.chat button:hover:not(:disabled) {
  background: #fff;
}
textarea {
  flex: 1;
  resize: none;
  font: inherit;
  color: inherit;
  padding: 0.4em 0.7em;
  border: 1px solid #dfe1ea;
  border-radius: 0.7em;
  background: rgb(255 255 255 / 0.95);
}
</style>

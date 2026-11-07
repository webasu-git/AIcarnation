<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import type { AgentVrmRef, UsageResponse } from '@aicarnation/shared'
import { fetchUsage } from './api/usage'
import VrmStage from './components/VrmStage.vue'
import ChatPanel from './components/ChatPanel.vue'
import AgentPanel from './components/AgentPanel.vue'
import MotionCard from './components/MotionCard.vue'
import SetupGuide from './components/SetupGuide.vue'
import BackgroundCard from './components/BackgroundCard.vue'
import AppIcon from './components/ui/AppIcon.vue'
import ToggleSwitch from './components/ui/ToggleSwitch.vue'
import VolumeSlider from './components/ui/VolumeSlider.vue'
import type { IconName } from './components/ui/AppIcon.vue'
import SegmentedControl from './components/ui/SegmentedControl.vue'
import { isSpeechSupported } from './voice/speech'
import { useVoiceLabel } from './voice/useVoiceLabel'
import { openEditor } from './components/editorState'
import { setSetupGuideClosed, setupGuideClosed, setupGuideExpanded } from './components/setupGuideState'
import { engineWarmup, parseEngineVoiceURI } from './voice/engines'
import { unlockAudio } from './voice/audio'
import { usePip } from './pip/usePip'
import { useVrmLoader } from './useVrmLoader'
import { useBridge } from './bridge/useBridge'
import { useBehavior } from './behavior/useBehavior'
import { useMotionLibrary } from './motion/useMotionLibrary'
import { IS_COMPANION, isCompanionSessionValid } from './runtime'
import { useSettingsStore } from './stores/settings'
import { useChatStore } from './stores/chat'
import { useAgentsStore } from './stores/agents'

// 開いたときだけ要る部品は、あとから読み込む（最初の表示を軽くするため）
const VoiceModels = defineAsyncComponent(() => import('./components/VoiceModels.vue'))
const VoiceDictionary = defineAsyncComponent(() => import('./components/VoiceDictionary.vue'))
const SourcesGuide = defineAsyncComponent(() => import('./components/SourcesGuide.vue'))

const settings = useSettingsStore()
const chat = useChatStore()
const agents = useAgentsStore()
const stageEl = ref<HTMLElement | null>(null)
const vrmStage = ref<InstanceType<typeof VrmStage> | null>(null)
const getViewer = () => vrmStage.value?.viewer ?? null

const loader = useVrmLoader(getViewer)
const pip = usePip(stageEl, getViewer)

const speechSupported = isSpeechSupported()
const dragging = ref(false)



const BRIDGE_DOT = { off: 'off', connecting: 'busy', connected: 'ok', error: 'ng' } as const

type SettingTab = 'character' | 'motion' | 'library' | 'display'
/**
 * 設定画面のタブ。キャラクター（見た目・背景・人格と声）／動き（キャラクターごとの動きの割り当て）／素材（キャラクターをまたぐ置き場と入手先）／設定。
 * 素材はすべて利用者が入れる
 */
const SETTING_TABS: readonly { id: SettingTab; label: string; icon: IconName }[] = [
  { id: 'character', label: 'キャラクター', icon: 'character' },
  { id: 'motion', label: '動き', icon: 'motion' },
  { id: 'library', label: '素材', icon: 'cube' },
  { id: 'display', label: '設定', icon: 'gear' },
]
const TAB_KEY = 'aicarnation:settings-tab'
/** 開いていたタブを覚えておく（この端末だけの便利のため。読めなければ最初のタブ） */
function savedTab(): SettingTab {
  try {
    const value = localStorage.getItem(TAB_KEY)
    return SETTING_TABS.some((t) => t.id === value) ? (value as SettingTab) : 'character'
  } catch {
    return 'character'
  }
}
const tab = ref<SettingTab>(savedTab())
/** 背景の画像・動画を読めなかったとき（背景のカードに出す） */
const backgroundError = ref('')
/** 表示中の背景の画像・動画の大きさ（ぼやけるかの目安を出すため） */
const backgroundSize = ref({ width: 0, height: 0 })

// --- キャラクタータブの「人格と声」のまとめ ---
const { label: currentVoiceLabel, isEngine: currentVoiceIsEngine } = useVoiceLabel(() => agents.current?.voice.voiceURI ?? '')
/** 人格のひとこと（一人称と口調。長ければ省略して見せる） */
const personaSummary = computed(() => {
  const a = agents.current
  if (!a) return ''
  const text = [a.firstPerson && `一人称「${a.firstPerson}」`, a.tone || a.personality].filter(Boolean).join('・')
  return text.length > 80 ? `${text.slice(0, 80)}…` : text || 'まだ説明がありません'
})
watch(tab, (value) => {
  try {
    localStorage.setItem(TAB_KEY, value)
  } catch {
    // 覚えられなくても困らない
  }
})

/** 吹き出しの出し方。アバターが隠れないよう、既定は「最新だけ」 */
const CAPTION_OPTIONS = [
  { value: 'latest', label: '最新だけ' },
  { value: 'all', label: 'すべて' },
  { value: 'off', label: 'なし' },
] as const
/** 会話していないときの身ぶりの多さ */
const IDLE_GESTURE_OPTIONS = [
  { value: 'more', label: '多め' },
  { value: 'normal', label: 'ふつう' },
  { value: 'less', label: '少なめ' },
  { value: 'off', label: 'しない' },
] as const
/** 画面のテーマ。システムはブラウザ（OS）の明るい・暗いに合わせる */
const THEME_OPTIONS = [
  { value: 'system', label: 'システム' },
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
] as const
const bridge = useBridge()
// 会話していないときは、ひとりで過ごす（身ぶり・退屈・居眠り）
/** 保存した動きのファイルを読み終えたか */
const motionsLoaded = ref(false)
/**
 * 声の準備ができたか。声がローカル音声エンジンなら、画面を開いたときに起こし始め、起動を待つ
 * （あいさつを起動前に始めると、最初の一言がブラウザの声になってしまうため）。使えないと分かったら待たない
 */
const voiceReady = ref(true)
watch(
  () => (settings.voiceEnabled ? parseEngineVoiceURI(agents.current?.voice.voiceURI ?? '')?.engine : undefined),
  async (engine) => {
    if (!engine || engineWarmup.isReady(engine)) {
      voiceReady.value = true
      return
    }
    voiceReady.value = false
    await engineWarmup.warmUp(engine)
    voiceReady.value = true
  },
  { immediate: true },
)
const behavior = useBehavior(
  getViewer,
  bridge.connection,
  computed(() => motionsLoaded.value && voiceReady.value && !!loader.current.value && !loader.loading.value),
)
const BRIDGE_LABELS = {
  off: 'オフ',
  connecting: '接続中…',
  connected: '待機中（Claude の会話に反応します）',
  error: IS_COMPANION
    ? 'Claude に接続できません（Claude Code のセッションや Claude Desktop を終了すると止まります。/aicarnation で開き直してください）'
    : 'ブリッジに接続できません（pnpm dev で起動しているかご確認ください）',
} as const

// --- 今日の利用回数 ---
const usage = ref<UsageResponse | null>(null)
async function refreshUsage() {
  // 同梱版は中継APIを使わないので、利用回数も無い
  if (IS_COMPANION) return
  try {
    usage.value = await fetchUsage()
  } catch {
    // 表示できないだけなので無視する
  }
}
// 応答が終わるたびに数え直す
watch(
  () => chat.sending,
  (sending) => {
    if (!sending) void refreshUsage()
  },
)

// エージェントを切り替えたら、その履歴と見た目に切り替える
watch(
  () => agents.current?.id,
  (id) => {
    if (id) void chat.load(id)
  },
)
watch(
  () => agents.current?.vrm,
  (vrm) => {
    if (vrm) void loader.loadRef(vrm)
  },
)

/** 選択中のエージェントの見た目を変える */
async function applyVrm(pick: Promise<AgentVrmRef | null>) {
  const vrm = await pick
  if (vrm && agents.current) await agents.update(agents.current.id, { vrm })
}


/** 「はじめに」の案内をもう一度出し、キャラクタータブへ移る */
function reopenGuide() {
  setSetupGuideClosed(false)
  setupGuideExpanded.value = true
  tab.value = 'character'
}

// 腰回りを崩れにくくするかは、キャラクターごと（無ければオン）
watch(
  () => agents.current?.steadyWaist !== false,
  (on) => getViewer()?.setSteadyWaist(on),
  { immediate: true },
)
function toggleSteadyWaist(on: boolean) {
  if (agents.current) void agents.update(agents.current.id, { steadyWaist: on })
}
// 話すときの手ぶりも、キャラクターごと（無ければオン。切り替えは「動き」タブ）
watch(
  () => agents.current?.talkGestures !== false,
  (on) => getViewer()?.setTalkGestures(on),
  { immediate: true },
)

function onModelFile(file: File) {
  void applyVrm(loader.pickFile(file))
}

/** はじめての案内から、動きのタブへ移る */
function showMotions() {
  tab.value = 'motion'
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) void applyVrm(loader.pickFile(file))
  input.value = ''
}

function onDrop(e: DragEvent) {
  dragging.value = false
  const file = e.dataTransfer?.files[0]
  if (file) void applyVrm(loader.pickFile(file))
}

/** 同梱版で、前のセッションの画面を開いている（合言葉が古い） */
const sessionExpired = ref(false)

onMounted(async () => {
  // 音声エンジンの声は、画面を一度操作するまで鳴らせない。操作のたびに再生を許可しておく
  window.addEventListener('pointerdown', unlockAudio)
  window.addEventListener('keydown', unlockAudio)
  const viewer = getViewer()
  if (viewer) {
    // 文字送りのタイマーは、ステージが今いるウィンドウ（本体か小窓）で回す
    chat.attachAvatar(viewer, () => stageEl.value?.ownerDocument.defaultView ?? window)
    behavior.start()
  }
  // 同梱版のデータは同梱サーバーにあるので、合言葉が古いと何も読めない。読み込む前に確かめて案内する
  if (IS_COMPANION && !(await isCompanionSessionValid())) {
    sessionExpired.value = true
    return
  }
  await Promise.all([settings.load(), agents.load()])
  void refreshUsage()
  await motionLibrary.loadAll()
  motionsLoaded.value = true
  // 動きはキャラクターごとに持つので、切り替えたら読み込み直す
  watch(
    () => agents.current?.id,
    () => void motionLibrary.loadAll(),
  )
})

// --- 動きのファイル（.vrma・Mixamo の .fbx） ---
const motionLibrary = useMotionLibrary(getViewer)
function clearHistory() {
  const name = agents.current?.name ?? 'エージェント'
  if (window.confirm(`${name}との会話履歴を削除してもよろしいですか？`)) void chat.clear()
}
</script>

<template>
  <div v-if="sessionExpired" class="expired" role="alert">
    <p class="expired-title">この画面は前のセッションのものです</p>
    <p>お手数ですが、Claude Code で <code>/aicarnation</code> を実行して開き直してください。</p>
  </div>
  <div class="app">
    <aside class="panel">
      <header class="brand">
        <img class="logo" src="/icons/logo.svg" alt="" width="34" height="34" />
        <div class="title">
          <h1><span class="title-ai">AI</span>carnation</h1>
          <p>with {{ agents.current?.name ?? 'あなたの相棒' }}</p>
        </div>
        <button
          v-if="pip.support !== 'none'"
          class="pip-button"
          :disabled="pip.mode.value !== 'none'"
          :title="pip.support === 'video' ? '動画の小窓で表示します（入力はこのタブで行ってください）' : '常に手前に表示される小窓で開きます'"
          @click="pip.open"
        >
          <AppIcon name="pip" :size="16" />小窓
        </button>
      </header>
      <nav class="tabs" role="tablist" aria-label="設定">
        <button
          v-for="t in SETTING_TABS"
          :key="t.id"
          class="tab"
          role="tab"
          :aria-selected="tab === t.id"
          :class="{ active: tab === t.id }"
          @click="tab = t.id"
        >
          <AppIcon :name="t.icon" :size="15" />{{ t.label }}
        </button>
      </nav>
      <!-- アプリ名とタブは動かさず、この中だけを縦に動かす -->
      <div class="panel-body">
        <p v-if="pip.support === 'none'" class="banner">このブラウザは小窓に対応していません。Chrome / Edge をお使いください。</p>
        <p v-if="pip.error.value" class="banner error">{{ pip.error.value }}</p>
        <p v-if="bridge.connection.value === 'connecting' || bridge.connection.value === 'error'" class="banner" :class="{ error: bridge.connection.value === 'error' }">
          {{ BRIDGE_LABELS[bridge.connection.value] }}
        </p>


        <template v-if="tab === 'character'">
          <SetupGuide :has-model="!!loader.current.value" @model-file="onModelFile" @show-motions="showMotions" />
          <AgentPanel v-collapsible="'agents'" />
          <section v-collapsible="'appearance'" class="card">
            <h2>
              <AppIcon name="shirt" />見た目
              <span class="chip" :class="{ ok: !!loader.current.value }">{{ loader.current.value ? '入っています' : 'まだありません' }}</span>
            </h2>
            <label class="drop" :class="{ disabled: loader.loading.value }">
              <AppIcon name="download" :size="16" />
              <span>{{ loader.loading.value ? '読み込み中…' : loader.current.value ? '別の VRM ファイルに替える' : 'VRM ファイルを選ぶ・ドロップ' }}</span>
              <input type="file" accept=".vrm" hidden :disabled="loader.loading.value" @change="onFileChange" />
            </label>
            <p v-if="!loader.loading.value && loader.current.value" class="hint">表示中：{{ loader.current.value }}</p>
            <p v-else-if="!loader.loading.value" class="hint">
              まだ 3D モデルが入っていません。ご自分で用意された .vrm を追加してください（VRoid Studio で作ることもできます）。モデルのライセンスは、ご自身でご確認のうえお守りください。
            </p>
            <ToggleSwitch
            v-if="loader.current.value"
            :model-value="agents.current?.steadyWaist !== false"
            @update:model-value="toggleSteadyWaist"
          >
            腰回りを崩れにくくする
          </ToggleSwitch>
          <p v-if="loader.current.value" class="hint">
            背骨のひねりや曲げの多くを胸に受け持たせ、腰の飾りや上着の裾が脚とずれにくくします。MMD から変換したモデルなどで、腰回りが引っ張られるときに効きます。
          </p>
          <p v-if="agents.current?.missing?.vrmFileName" class="hint">
              読み込んだ設定では「{{ agents.current.missing.vrmFileName }}」が使われていました。同じモデルをご用意のうえ、追加してください。
            </p>
            <p v-if="loader.error.value" class="error">{{ loader.error.value }}</p>
          </section>
          <BackgroundCard
            v-if="agents.current"
            v-collapsible="'background'"
            :get-viewer="getViewer"
            :error="backgroundError"
            :size="backgroundSize"
            @clear-error="backgroundError = ''"
          />
          <section v-if="agents.current" v-collapsible="'persona'" class="card">
            <h2><AppIcon name="persona" />人格と声</h2>
            <dl class="summary">
              <dt>人格</dt>
              <dd>{{ personaSummary }}</dd>
              <dt>声</dt>
              <dd>
                {{ currentVoiceLabel }}
                <span v-if="!currentVoiceIsEngine" class="chip">標準</span>
              </dd>
            </dl>
            <p v-if="agents.current.missing?.voice" class="hint">
              読み込んだ設定では、AivisSpeech の声「{{ agents.current.missing.voice.speaker }}（{{ agents.current.missing.voice.style }}）」が使われていました。声のモデルを「素材」タブで追加してから、「声を編集」でお選びください。
            </p>
            <div class="card-actions">
              <button :disabled="chat.streaming" @click="openEditor(agents.current, 1)"><AppIcon name="pencil" :size="14" />人格を編集</button>
              <button :disabled="chat.streaming" @click="openEditor(agents.current, 3)"><AppIcon name="speaker" :size="14" />声を編集</button>
            </div>
          </section>
        </template>

        <template v-else-if="tab === 'motion'">
          <MotionCard v-if="agents.current" v-collapsible="'motions'" :library="motionLibrary" :get-viewer="getViewer" />
        </template>

        <template v-else-if="tab === 'library'">
          <section v-collapsible="'voice-models'" class="card">
            <h2><AppIcon name="wave" />声のモデル</h2>
            <VoiceModels />
          </section>
          <section v-collapsible="'dictionary'" class="card">
            <h2><AppIcon name="book" />読みの辞書</h2>
            <VoiceDictionary :voice="agents.current?.voice ?? null" />
          </section>
          <section v-collapsible="'sources'" class="card">
            <h2><AppIcon name="external" />素材の入手先</h2>
            <SourcesGuide />
          </section>
        </template>

        <template v-else>
          <section v-collapsible="'speech'" class="card">
            <h2><AppIcon name="talk" />読み上げと会話</h2>
            <ToggleSwitch v-if="speechSupported" v-model="settings.voiceEnabled">返事を声で読み上げる</ToggleSwitch>
            <div v-if="speechSupported" class="field">
              <span>音量</span>
              <VolumeSlider v-model="settings.volume" :disabled="!settings.voiceEnabled" />
            </div>
            <div class="field">
              <span>ひとりのときの身ぶり</span>
              <SegmentedControl v-model="settings.idleGestures" :options="IDLE_GESTURE_OPTIONS" label="会話していないときの身ぶりの多さ" />
            </div>
            <ToggleSwitch v-model="settings.dozeEnabled">長く話しかけないと居眠りする</ToggleSwitch>
            <p class="hint">会話していない間に、見回す・ほほえむなどの身ぶりをする多さです。作業中に気になる場合は「少なめ」か「しない」をお選びください。居眠りは、30 分ほど話しかけないと始まります。</p>
            <template v-if="!IS_COMPANION">
              <div v-if="usage" class="meter">
                <div class="meter-label">
                  <span>今日の残り</span>
                  <span>
                    <strong>{{ Math.max(usage.limit - usage.used, 0) }}</strong> / {{ usage.limit }} 回
                  </span>
                </div>
                <div class="meter-bar">
                  <span :style="{ width: `${Math.min(100, (usage.used / Math.max(usage.limit, 1)) * 100)}%` }" />
                </div>
                <p class="hint">日本時間の0時にリセットされます</p>
              </div>
              <button class="text-button" :disabled="chat.streaming || chat.messages.length === 0" @click="clearHistory">
                <AppIcon name="trash" :size="14" />{{ agents.current?.name }}との会話履歴を消す
              </button>
            </template>
          </section>
          <section v-collapsible="'display'" class="card">
            <h2><AppIcon name="sliders" />表示</h2>
            <div class="field">
              <span>テーマ</span>
              <SegmentedControl v-model="settings.theme" :options="THEME_OPTIONS" label="画面のテーマ" />
            </div>
            <div class="field">
              <span>吹き出し</span>
              <SegmentedControl v-model="settings.captionMode" :options="CAPTION_OPTIONS" label="吹き出しの出し方" />
            </div>
            <button class="text-button quiet" @click="reopenGuide">
              <AppIcon name="redo" :size="14" />{{ setupGuideClosed ? '「はじめに」の案内をもう一度出す' : '「はじめに」の案内を見る' }}
            </button>
            <button class="text-button quiet" :disabled="!loader.current.value" @click="getViewer()?.resetCamera()">
              <AppIcon name="camera-orbit" :size="14" />カメラを最初の位置に戻す
            </button>
          </section>
          <section v-if="!IS_COMPANION" v-collapsible="'claude'" class="card">
            <h2><AppIcon name="link" />Claude 連携</h2>
            <ToggleSwitch v-model="settings.bridgeEnabled">Claude の会話に反応する</ToggleSwitch>
            <div class="status" :class="BRIDGE_DOT[bridge.connection.value]">
              <span class="dot" aria-hidden="true" />
              <span>{{ BRIDGE_LABELS[bridge.connection.value] }}</span>
            </div>
            <p v-if="settings.bridgeEnabled" class="hint">
              返事は「{{ agents.current?.name }}」の口調で要約してお話しします。Claude Code 側に連携用の mod が必要です。
            </p>
          </section>
        </template>
      </div>
    </aside>

    <main class="stage-host">
      <div
        ref="stageEl"
        class="stage"
        :class="{ dragging }"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <VrmStage
          ref="vrmStage"
          :background="agents.current?.backdrop"
          :paused="settings.backgroundPaused"
          :shadow="settings.groundShadow"
          :backdrop-light="settings.backdropLight"
          @background-error="backgroundError = $event"
          @background-size="backgroundSize = $event"
        />
        <button
          v-if="loader.current.value"
          type="button"
          class="camera-reset"
          title="カメラを最初の位置に戻します（右ドラッグで回転、ホイールで拡大・縮小、ホイールボタンのドラッグで移動できます）"
          aria-label="カメラを最初の位置に戻す"
          @click="getViewer()?.resetCamera()"
        >
          <AppIcon name="camera-orbit" :size="22" />
        </button>
        <div v-if="!loader.current.value && !loader.loading.value" class="empty-stage">
          <AppIcon name="download" :size="28" />
          <p>3D モデル（.vrm）をここにドロップしてください</p>
          <span>モデルが無い間も、声と吹き出しでお話しします</span>
        </div>
        <ChatPanel :connection="bridge.connection.value" />
      </div>
      <div v-if="pip.mode.value !== 'none'" class="pip-active">
        <AppIcon name="pip" :size="28" />
        <p>小窓で表示中</p>
        <button @click="pip.exit">小窓を閉じる</button>
      </div>
    </main>
  </div>
</template>

<style scoped>
.expired {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 16px;
  text-align: center;
  color: var(--text);
  background: var(--bg);
}
.expired-title {
  font-weight: 700;
  font-size: 1.05rem;
}
.app {
  /* 画面の高さいっぱいに使い、左の設定とアバターの高さを揃える（設定は中だけ縦に動かす） */
  --app-pad: 28px;
  display: flex;
  justify-content: center;
  gap: 28px;
  height: 100vh;
  padding: var(--app-pad);
  box-sizing: border-box;
}
.panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 340px;
  flex-shrink: 0;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
/* 設定の中身。アプリ名とタブは上に残し、ここだけを縦に動かす */
.panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  /* スクロールバーが出ても中身の幅が変わらないように */
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  padding-right: 4px;
  box-sizing: border-box;
}

/* --- 上の帯：アプリ名と小窓ボタン --- */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 4px 2px;
}
.logo {
  flex-shrink: 0;
}
.title {
  flex: 1;
  min-width: 0;
}
/* アプリ名は上品な書体に。大文字の I が小文字の l と同じ形になって「Alcarnation」と読めないよう、
   I に横線のある書体を使い、「AI」の部分だけ色を変える */
.title h1 {
  margin: 0;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 1.15rem;
  font-weight: 500;
  letter-spacing: 0.06em;
}
.title-ai {
  color: var(--accent);
}
.title p {
  margin: 0;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 0.8rem;
  letter-spacing: 0.04em;
  color: var(--muted);
}
/* 小窓ボタンは、ロゴの金に合わせた細い縁で控えめに */
.pip-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  border: 1px solid color-mix(in srgb, var(--gold) 50%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--gold) 7%, transparent);
  color: var(--gold-text);
  font-size: 0.8rem;
  font-weight: 500;
}
.pip-button:hover:not(:disabled) {
  border-color: var(--gold);
  background: color-mix(in srgb, var(--gold) 14%, transparent);
}
.banner {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 0.8rem;
  color: var(--muted);
}
.banner.error {
  background: var(--danger-soft);
  color: var(--danger);
}

/* --- 見た目 --- */
.drop {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
  padding: 10px;
  border: 1.5px dashed var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
  color: var(--muted);
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;
}
.drop:hover:not(.disabled) {
  border-color: var(--accent);
  color: var(--accent-strong);
}
.drop.disabled {
  cursor: default;
  opacity: 0.6;
}

/* --- 声と会話 --- */
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  font-size: 0.82rem;
  color: var(--muted);
}
.meter {
  margin-top: 14px;
}
.meter-label {
  display: flex;
  justify-content: space-between;
  font-size: 0.82rem;
  color: var(--muted);
}
.meter-label strong {
  color: var(--text);
  font-size: 0.95rem;
}
.meter-bar {
  height: 6px;
  margin-top: 6px;
  border-radius: 999px;
  background: var(--surface);
  overflow: hidden;
}
.meter-bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), #a78bfa);
}
/* --- 動き --- */
.text-button {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding: 4px 0;
  border: none;
  background: none;
  font-size: 0.8rem;
  color: var(--muted);
}
.text-button:hover:not(:disabled) {
  background: none;
  color: var(--danger);
}
/* 消す操作ではない文字のボタンは、指を乗せてもアクセント色にとどめる */
.text-button.quiet:hover:not(:disabled) {
  color: var(--accent);
}
.text-button + .text-button {
  margin-top: 2px;
}

/* --- 小窓の右上：カメラを最初の位置に戻す --- */
.camera-reset {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgb(255 255 255 / 0.85);
  color: #6b7085;
  opacity: 0.55;
  transition: opacity 0.2s ease;
}
.stage:hover .camera-reset,
.camera-reset:focus-visible {
  opacity: 1;
}

/* --- モデルが入っていないときのステージ --- */
.empty-stage {
  position: absolute;
  inset: 0 0 auto;
  height: 70%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #6b7085;
  text-align: center;
  pointer-events: none;
}
.empty-stage p {
  margin: 0;
  font-weight: 600;
}
.empty-stage span {
  font-size: 0.8rem;
}

/* --- カードの見出しの状態・人格と声のまとめ --- */
.panel h2 .chip {
  margin-left: auto;
}
.chip {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 600;
  white-space: nowrap;
}
.chip.ok {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.summary {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: 0.82rem;
}
.summary dt {
  color: var(--muted);
}
.summary dd {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.card-actions button {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8rem;
}

/* --- 設定のタブ --- */
.tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  box-shadow: var(--shadow);
}
.tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 4px;
  border: none;
  border-radius: 999px;
  background: none;
  color: var(--muted);
  font-size: 0.78rem;
  font-weight: 600;
  white-space: nowrap;
}
.tab:hover:not(.active) {
  background: var(--surface);
  color: var(--text);
}
.tab.active {
  background: var(--accent);
  color: #fff;
}

/* --- 連携の状態 --- */
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 0.8rem;
}
.dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}
.status.ok .dot {
  background: var(--success);
  box-shadow: 0 0 0 3px rgb(34 160 107 / 0.2);
}
.status.busy .dot {
  background: var(--warning);
}
.status.ng .dot {
  background: var(--danger);
}

/* --- 背景色 --- */
/* --- ステージ --- */
.stage-host {
  position: relative;
  /* 画面の高さに合わせて大きくし、縦長の比率（小窓の初期サイズ 420×660 に近い 9:14）を保つ */
  height: 100%;
  aspect-ratio: 9 / 14;
  max-width: calc(100vw - 340px - 28px - var(--app-pad) * 2);
  flex-shrink: 0;
}
.stage {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgb(20 22 40 / 0.14);
}
.stage.dragging {
  outline: 3px dashed var(--accent);
  outline-offset: -3px;
}
.pip-active {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 20px;
  background: var(--card);
  border: 1.5px dashed var(--border);
  color: var(--muted);
}
.pip-active p {
  margin: 0;
  color: var(--text);
  font-weight: 600;
}
/* 動画PiP中はステージを本体タブに残したまま、上に案内を重ねる */
.stage-host:has(.stage) .pip-active {
  background: color-mix(in srgb, var(--card) 85%, transparent);
}
</style>

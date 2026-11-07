<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import {
  DEFAULT_VOICE,
  EMOTION_TAG_INSTRUCTION,
  MAX_AGENT_DESCRIPTION_CHARS,
  MAX_AGENT_IMAGES,
  MAX_VOICE_OPTIONS,
  NO_VRM,
  type AgentDefinition,
  type AgentIcon,
  type AgentVoice,
  type AgentVrmRef,
  type GeneratedAgent,
  type VoiceOption,
} from '@aicarnation/shared'
import { generateAgent, suggestVoice } from '../api/agents'
import { ApiError } from '../api/client'
import { toAgentImage, type PickedImage } from '../agents/imageInput'
import { saveVrmFile } from '../db/vrmFiles'
import { useAgentsStore } from '../stores/agents'
import { isSpeechSupported, listVoices, speak, stopSpeech, toVoiceOptions, voiceNotice } from '../voice/speech'
import { ENGINES, engineVoiceURI, listEngineStyles, parseEngineVoiceURI, type EngineId, type EngineStyle } from '../voice/engines'
import { IS_COMPANION } from '../runtime'
import SegmentedControl from './ui/SegmentedControl.vue'
import IconPicker from './IconPicker.vue'
import { avatarColor } from '../agents/avatarColor'
import { loadIconImage, measureImage } from '../agents/iconImages'
import type { IconView } from '../agents/iconLayout'

/** agent を渡すと編集、渡さなければ新規作成 */
const props = defineProps<{ agent?: AgentDefinition; initialStep?: 1 | 2 | 3; focusName?: boolean }>()
const emit = defineEmits<{ close: [] }>()

const agents = useAgentsStore()
const step = ref<1 | 2 | 3>(1)

// --- ① 設定 ---
const description = ref('')
/** 生成にだけ使い、保存しない */
const images = ref<PickedImage[]>([])
const imageError = ref('')
const generating = ref(false)
const generateError = ref('')

async function onImages(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  imageError.value = ''
  for (const file of files) {
    if (images.value.length >= MAX_AGENT_IMAGES) {
      imageError.value = `画像は${MAX_AGENT_IMAGES}枚までお選びいただけます`
      break
    }
    try {
      images.value.push(await toAgentImage(file))
    } catch (err) {
      imageError.value = `${file.name}：${err instanceof Error ? err.message : String(err)}`
    }
  }
}

const canGenerate = computed(() => !generating.value && (description.value.trim() !== '' || images.value.length > 0))

/** 感情タグの指示はアプリが付けるので、編集欄には出さない */
const stripInstruction = (prompt: string) => prompt.replace(EMOTION_TAG_INSTRUCTION, '').trim()

const form = reactive({
  name: props.agent?.name ?? '',
  firstPerson: props.agent?.firstPerson ?? '',
  tone: props.agent?.tone ?? '',
  personality: props.agent?.personality ?? '',
  background: props.agent?.background ?? '',
  topics: props.agent?.topics.join('\n') ?? '',
  forbidden: props.agent?.forbidden.join('\n') ?? '',
  appearance: props.agent?.appearance ?? '',
  systemPrompt: stripInstruction(props.agent?.systemPrompt ?? ''),
})

const lines = (text: string) =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

async function generate() {
  if (!canGenerate.value) return
  generating.value = true
  generateError.value = ''
  try {
    const result = await generateAgent({
      description: description.value.trim(),
      images: images.value.map((p) => p.image),
    })
    Object.assign(form, {
      ...result,
      topics: result.topics.join('\n'),
      forbidden: result.forbidden.join('\n'),
      systemPrompt: stripInstruction(result.systemPrompt),
    })
  } catch (err) {
    generateError.value = err instanceof ApiError ? err.message : '設定を作成できませんでした'
  } finally {
    generating.value = false
  }
}

const settingsReady = computed(() => form.name.trim() !== '' && form.systemPrompt.trim() !== '')

// アイコンの画像（いちばん上）。元の画像はそのまま保存し、位置と拡大だけを覚える
const iconImage = shallowRef<{ url: string; width: number; height: number } | null>(null)
const iconView = ref<IconView>({ x: props.agent?.icon?.x ?? 0.5, y: props.agent?.icon?.y ?? 0.5, zoom: props.agent?.icon?.zoom ?? 1 })
/** 新しく選んだ画像（保存するときにファイルにする）。null なら、もとの画像のまま */
const iconFile = shallowRef<File | null>(null)
/** もとの画像を外したか */
const iconRemoved = ref(false)
/** 新しく選んだ画像の URL（閉じるときに解放する） */
let pickedIconUrl = ''
const iconColor = avatarColor(props.agent?.id ?? form.name)
if (props.agent?.icon) {
  const fileId = props.agent.icon.fileId
  void loadIconImage(fileId).then((loaded) => {
    if (!iconFile.value && !iconRemoved.value) iconImage.value = loaded
  })
}
async function pickIcon(file: File) {
  const url = URL.createObjectURL(file)
  const size = await measureImage(url)
  if (!size) {
    URL.revokeObjectURL(url)
    return
  }
  if (pickedIconUrl) URL.revokeObjectURL(pickedIconUrl)
  pickedIconUrl = url
  iconFile.value = file
  // 読み込んだ設定で使っていたのと同じ名前の画像なら、覚えていた位置と大きさに戻す
  const saved = props.agent?.missing?.icon
  iconView.value = saved && saved.name === file.name ? { x: saved.x, y: saved.y, zoom: saved.zoom } : { x: 0.5, y: 0.5, zoom: 1 }
  iconImage.value = { url, ...size }
}
function removeIcon() {
  iconFile.value = null
  iconRemoved.value = true
  iconImage.value = null
}
onBeforeUnmount(() => {
  if (pickedIconUrl) URL.revokeObjectURL(pickedIconUrl)
})
async function resolveIcon(): Promise<AgentIcon | undefined> {
  const view = iconView.value
  if (iconFile.value) return { fileId: await saveVrmFile(iconFile.value), name: iconFile.value.name, ...view }
  if (props.agent?.icon && !iconRemoved.value) return { ...props.agent.icon, ...view }
  return undefined
}

// --- ② 見た目 ---
// 3D モデルは利用者が入れる。まだ無ければ「あとで入れる」にしておける
type VrmChoice = { kind: 'keep' } | { kind: 'none' } | { kind: 'file'; file: File }
const hasCurrentVrm = computed(() => props.agent?.vrm.source === 'local')
const vrmChoice = ref<VrmChoice>(hasCurrentVrm.value ? { kind: 'keep' } : { kind: 'none' })
const fileError = ref('')

function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.vrm')) {
    fileError.value = '.vrm ファイルをお選びください'
    input.value = ''
    return
  }
  fileError.value = ''
  vrmChoice.value = { kind: 'file', file }
}


// --- ③ 声 ---
const speechSupported = isSpeechSupported()
const voices = shallowRef<SpeechSynthesisVoice[]>([])
const voice = reactive<AgentVoice>({ ...(props.agent?.voice ?? DEFAULT_VOICE) })
/** 音声エンジンの抑揚・テンポの緩急・感情に合わせるか（以前の定義には無いので、既定値で見せる） */
const voiceIntonation = computed({ get: () => voice.intonation ?? 1, set: (v: number) => (voice.intonation = v) })
const voiceTempo = computed({ get: () => voice.tempo ?? 1, set: (v: number) => (voice.tempo = v) })
const voiceEmotional = computed({ get: () => voice.emotional !== false, set: (v: boolean) => (voice.emotional = v) })
const suggesting = ref(false)
const suggestReason = ref('')
let voicesLoaded = false

/** 日本語の声を先に並べる */
const voiceList = computed(() => {
  const isJa = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().startsWith('ja')
  return [...voices.value.filter(isJa), ...voices.value.filter((v) => !isJa(v))]
})

/** 声の出し方：ブラウザの声か、ローカル音声エンジン（AivisSpeech）か */
type VoiceSource = 'browser' | EngineId
const SOURCE_OPTIONS = [{ value: 'browser', label: 'ブラウザ' }, ...ENGINES.map((e) => ({ value: e.id, label: e.label }))]
const SOURCE_HINTS: Record<VoiceSource, string> = IS_COMPANION
  ? {
      browser: 'OS に入っている声です。準備は不要ですが、機械的に聞こえます。',
      aivis: '自然で表情豊かな声です。Claude Code で /aicarnation-voice install aivis を実行してインストールすると、お使いいただけます（無料・この PC の中で動きます）。設定の「声のモデル」で .aivmx を追加すると、声を増やせます。',
    }
  : {
      browser: 'OS に入っている声です。準備は不要ですが、機械的に聞こえます。',
      aivis: '自然で表情豊かな声です。AivisSpeech を起動しておくと、お使いいただけます（無料・この PC の中で動きます）。設定の「声のモデル」で .aivmx を追加すると、声を増やせます。',
    }
const voiceSource = ref<VoiceSource>(parseEngineVoiceURI(voice.voiceURI)?.engine ?? 'browser')
const engineStyles = shallowRef<EngineStyle[]>([])
/** 自分で入れた声と、AivisSpeech に最初から入っている声（一覧では分けて出す） */
const ownStyles = computed(() => engineStyles.value.filter((s) => !s.isDefault))
const defaultStyles = computed(() => engineStyles.value.filter((s) => s.isDefault))
const engineState = ref<'idle' | 'loading' | 'starting' | 'ready' | 'error'>('idle')
const engineError = ref('')

/**
 * 同梱版では、エンジンにつながらないとプラグインが裏で起動する。起動には数十秒かかるので、その間は待ち直す。
 * 開発版はエンジンを自分で起動するので待たない
 */
const ENGINE_START_WAIT_MS = 120_000
const ENGINE_RETRY_MS = 3_000

/** エンジンの話者一覧を読み込む。起動していなければ（同梱版は起動を待ってから）案内を出す */
async function connectEngine(engine: EngineId) {
  engineState.value = 'loading'
  engineError.value = ''
  const deadline = Date.now() + (IS_COMPANION ? ENGINE_START_WAIT_MS : 0)
  for (;;) {
    try {
      engineStyles.value = await listEngineStyles(engine)
      engineState.value = 'ready'
      return
    } catch {
      engineStyles.value = []
      // 待っている間に出し方を切り替えられたら、やめる
      if (voiceSource.value !== engine) return
      if (Date.now() < deadline) {
        engineState.value = 'starting'
        await new Promise((resolve) => setTimeout(resolve, ENGINE_RETRY_MS))
        continue
      }
      engineState.value = 'error'
      const label = ENGINES.find((e) => e.id === engine)?.label ?? engine
      engineError.value = IS_COMPANION
        ? `${label}を起動できませんでした。まだインストールされていない場合は、Claude Code で /aicarnation-voice install ${engine} を実行してから「もう一度確かめる」を押してください。`
        : `${label}が起動していません。アプリを起動してから「もう一度確かめる」を押してください。`
      return
    }
  }
}

/** 今の出し方で選べる声（おすすめを聞くときに渡す） */
function voiceOptions(): VoiceOption[] {
  const source = voiceSource.value
  if (source === 'browser') return toVoiceOptions(voices.value, MAX_VOICE_OPTIONS)
  return engineStyles.value.slice(0, MAX_VOICE_OPTIONS).map((s) => ({
    voiceURI: engineVoiceURI(source, s.styleId),
    name: `${s.speaker}（${s.style}）`,
    lang: 'ja-JP',
  }))
}

async function askSuggestion() {
  const options = voiceOptions()
  if (options.length === 0 || suggesting.value) return
  suggesting.value = true
  suggestReason.value = ''
  try {
    const result = await suggestVoice({
      agent: {
        name: form.name,
        firstPerson: form.firstPerson,
        tone: form.tone,
        personality: form.personality,
        appearance: form.appearance,
      },
      voices: options,
    })
    voice.voiceURI = result.voiceURI || (options[0]?.voiceURI ?? '')
    suggestReason.value = result.reason
  } catch (err) {
    // おすすめが無くても選べるよう、先頭の声にしておく
    if (voiceSource.value !== 'browser') voice.voiceURI = options[0]?.voiceURI ?? ''
    suggestReason.value = err instanceof ApiError ? `おすすめを取得できませんでした：${err.message}` : 'おすすめを取得できませんでした'
  } finally {
    suggesting.value = false
  }
}

// 出し方を切り替えたら、その出し方の声を選び直す
watch(voiceSource, async (source) => {
  suggestReason.value = ''
  if (source === 'browser') {
    if (parseEngineVoiceURI(voice.voiceURI)) voice.voiceURI = ''
    return
  }
  await connectEngine(source)
  const current = parseEngineVoiceURI(voice.voiceURI)
  if (engineState.value === 'ready' && current?.engine !== source) await askSuggestion()
})

/** 声のステップに初めて来たら一覧を読み込み、声が未設定ならおすすめを聞く */
async function openVoiceStep() {
  step.value = 3
  if (voicesLoaded) return
  voicesLoaded = true
  if (speechSupported) voices.value = await listVoices()
  if (voiceSource.value !== 'browser') await connectEngine(voiceSource.value)
  if (!voice.voiceURI) await askSuggestion()
}

function preview() {
  stopPreview()
  const name = form.name.trim() || 'わたし'
  const me = form.firstPerson.trim() || 'わたし'
  const first = speak(`こんにちは。${me}は${name}です。`, { ...voice })
  // 音声エンジンで感情に合わせる設定なら、喜びの調子も続けて聞かせる
  if (voiceSource.value === 'browser' || voice.emotional === false) return
  let stopped = false
  const stop = () => (stopped = true)
  previewStops.add(stop)
  void first.ended.then(() => {
    previewStops.delete(stop)
    if (!stopped) speak('今日も一緒にがんばろうね！', { ...voice }, 'happy')
  })
}

/** 試しに聞いている途中で止めたら、続きの文を読まない */
const previewStops = new Set<() => void>()
function stopPreview() {
  for (const stop of previewStops) stop()
  previewStops.clear()
  stopSpeech()
}

// 「声を編集」などから開いたときは、その段から始める（新しく作るときは① から）
// 複製した直後などは、名前の欄を選んだ状態にして、すぐ打ち替えられるようにする
const nameInput = ref<HTMLInputElement | null>(null)
if (props.focusName) {
  void nextTick(() => {
    nameInput.value?.scrollIntoView({ block: 'center' })
    nameInput.value?.focus()
    nameInput.value?.select()
  })
}

if (props.agent && props.initialStep === 3) void openVoiceStep()
else if (props.agent && props.initialStep === 2) step.value = 2

onBeforeUnmount(stopPreview)

// --- 保存 ---
const saving = ref(false)
const saveError = ref('')

async function resolveVrm(): Promise<AgentVrmRef> {
  const choice = vrmChoice.value
  if (choice.kind === 'file') return { source: 'local', ref: await saveVrmFile(choice.file) }
  if (choice.kind === 'keep' && props.agent) return props.agent.vrm
  return NO_VRM
}

async function save() {
  if (!settingsReady.value || saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    const fields: GeneratedAgent = {
      name: form.name.trim(),
      firstPerson: form.firstPerson.trim(),
      tone: form.tone.trim(),
      personality: form.personality.trim(),
      background: form.background.trim(),
      topics: lines(form.topics),
      forbidden: lines(form.forbidden),
      appearance: form.appearance.trim(),
      systemPrompt: form.systemPrompt.trim(),
    }
    const vrm = await resolveVrm()
    const icon = await resolveIcon()
    const chosenVoice: AgentVoice = { ...voice }
    if (props.agent) await agents.update(props.agent.id, { ...fields, vrm, voice: chosenVoice, icon })
    else {
      const created = await agents.create(fields, vrm, chosenVoice)
      if (icon) await agents.update(created.id, { icon })
    }
    emit('close')
  } catch (err) {
    saveError.value = `保存できませんでした：${err instanceof Error ? err.message : String(err)}`
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true">
      <header>
        <h2>{{ agent ? `${agent.name}を編集` : 'エージェントを作る' }}</h2>
        <ol class="steps">
          <li :class="{ active: step === 1 }">① 設定</li>
          <li :class="{ active: step === 2 }">② 見た目</li>
          <li :class="{ active: step === 3 }">③ 声</li>
        </ol>
      </header>

      <section v-if="step === 1" class="body">
        <IconPicker
          v-model:view="iconView"
          class="icon-row"
          :image="iconImage"
          :name="form.name"
          :color="iconColor"
          :missing-name="iconImage ? undefined : agent?.missing?.icon?.name"
          @pick="pickIcon"
          @remove="removeIcon"
        />
        <div class="generate">
          <label for="desc">どんなキャラクターにしたいか、ご自由にお書きください</label>
          <textarea
            id="desc"
            v-model="description"
            rows="3"
            :maxlength="MAX_AGENT_DESCRIPTION_CHARS"
            placeholder="例：元気な関西弁の女の子。ゲームが好きで、ちょっとおせっかい"
          />
          <!-- 同梱版は Claude Code のモデルで作るため、画像は渡せない -->
          <div v-if="!IS_COMPANION" class="images">
            <figure v-for="(p, i) in images" :key="i" class="thumb">
              <img :src="p.preview" alt="" />
              <button type="button" aria-label="この画像を外す" @click="images.splice(i, 1)">×</button>
            </figure>
            <label v-if="images.length < MAX_AGENT_IMAGES" class="add-image">
              ＋ 画像を追加（{{ images.length }}/{{ MAX_AGENT_IMAGES }}）
              <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden @change="onImages" />
            </label>
          </div>
          <p v-if="!IS_COMPANION" class="hint">画像を添えていただくと、見た目・雰囲気・服装から性格と口調を推測します。画像は保存されません。</p>
          <p v-if="imageError" class="error">{{ imageError }}</p>
          <div class="row">
            <button class="primary" :disabled="!canGenerate" @click="generate">
              {{ generating ? '作成中…' : 'Claude に設定を作ってもらう' }}
            </button>
            <span class="hint">作成された内容は、下で自由に修正できます</span>
          </div>
          <p v-if="generateError" class="error">{{ generateError }}</p>
        </div>

        <div class="grid">
          <label>名前 <input ref="nameInput" v-model="form.name" /></label>
          <label>一人称 <input v-model="form.firstPerson" /></label>
          <label class="wide">口調 <input v-model="form.tone" /></label>
          <label class="wide">性格 <input v-model="form.personality" /></label>
          <label class="wide">背景 <textarea v-model="form.background" rows="2" /></label>
          <label>得意な話題（1行に1つ） <textarea v-model="form.topics" rows="3" /></label>
          <label>避けること（1行に1つ） <textarea v-model="form.forbidden" rows="3" /></label>
          <label class="wide">見た目のメモ <input v-model="form.appearance" /></label>
          <label class="wide">
            システムプロンプト（キャラクターへの指示文）
            <textarea v-model="form.systemPrompt" rows="6" />
            <span class="hint">感情タグ（[happy] など）の指示は、保存時にアプリが自動で付け加えます</span>
          </label>
        </div>
      </section>

      <section v-else-if="step === 3" class="body">
        <div class="source">
          <span>声の出し方</span>
          <SegmentedControl v-model="voiceSource" :options="SOURCE_OPTIONS" label="声の出し方" />
          <p class="hint">{{ SOURCE_HINTS[voiceSource] }}</p>
        </div>

        <template v-if="voiceSource === 'browser'">
          <p v-if="!speechSupported" class="error">お使いのブラウザは読み上げに対応していません。</p>
          <div v-else class="row">
            <label class="voice-select">
              声
              <select v-model="voice.voiceURI">
                <option value="">ブラウザの既定の声</option>
                <option v-for="v in voiceList" :key="v.voiceURI" :value="v.voiceURI">{{ v.name }}（{{ v.lang }}）</option>
              </select>
            </label>
            <button :disabled="suggesting || voices.length === 0" @click="askSuggestion">
              {{ suggesting ? '選んでいます…' : 'おすすめを聞く' }}
            </button>
          </div>
        </template>
        <template v-else>
          <p v-if="engineState === 'loading'" class="hint">話者を読み込んでいます。しばらくお待ちください…</p>
          <p v-else-if="engineState === 'starting'" class="hint">
            エンジンを起動しています…（数十秒かかる場合があります。起動すると話者が表示されます）
          </p>
          <div v-else-if="engineState === 'error'" class="engine-error">
            <p class="error">{{ engineError }}</p>
            <button @click="connectEngine(voiceSource)">もう一度確かめる</button>
          </div>
          <div v-else class="row">
            <label class="voice-select">
              話者
              <select v-model="voice.voiceURI">
                <optgroup v-if="ownStyles.length" label="追加した声">
                  <option v-for="s in ownStyles" :key="s.styleId" :value="engineVoiceURI(voiceSource, s.styleId)">
                    {{ s.speaker }}（{{ s.style }}）
                  </option>
                </optgroup>
                <optgroup v-if="defaultStyles.length" label="最初から入っている声（AivisSpeech）">
                  <option v-for="s in defaultStyles" :key="s.styleId" :value="engineVoiceURI(voiceSource, s.styleId)">
                    {{ s.speaker }}（{{ s.style }}）
                  </option>
                </optgroup>
              </select>
            </label>
            <button :disabled="suggesting || engineStyles.length === 0" @click="askSuggestion">
              {{ suggesting ? '選んでいます…' : 'おすすめを聞く' }}
            </button>
          </div>
        </template>
        <p v-if="suggestReason" class="hint">おすすめ：{{ suggestReason }}</p>

        <template v-if="voiceSource !== 'browser' || speechSupported">
          <label class="slider">
            話す速さ <input v-model.number="voice.rate" type="range" min="0.5" max="2" step="0.1" />
            <span>{{ voice.rate.toFixed(1) }}</span>
          </label>
          <!-- 声の高さはブラウザの声だけ（AivisSpeech は高さを変えると音質が落ちるため、声のモデルそのものを選ぶ） -->
          <label v-if="voiceSource === 'browser'" class="slider">
            声の高さ <input v-model.number="voice.pitch" type="range" min="0" max="2" step="0.1" />
            <span>{{ voice.pitch.toFixed(1) }}</span>
          </label>
          <template v-if="voiceSource !== 'browser'">
            <label class="slider">
              抑揚 <input v-model.number="voiceIntonation" type="range" min="0" max="2" step="0.05" />
              <span>{{ voiceIntonation.toFixed(2) }}</span>
            </label>
            <label class="slider">
              テンポの緩急 <input v-model.number="voiceTempo" type="range" min="0" max="2" step="0.05" />
              <span>{{ voiceTempo.toFixed(2) }}</span>
            </label>
            <label class="check">
              <input v-model="voiceEmotional" type="checkbox" />
              感情に合わせて声の調子を変える
            </label>
            <p class="hint">
              喜び・驚きでは抑揚を強く弾ませ、悲しみでは控えめにゆっくり話します。声のモデルに「喜び」「悲しみ」などのスタイルがある場合は、そのスタイルに切り替えます。
            </p>
          </template>
          <button @click="preview">試しに聞く</button>
          <p v-if="voiceNotice" class="hint">{{ voiceNotice }}</p>
        </template>
      </section>

      <section v-else class="body">
        <p class="hint">
          3D モデル（.vrm）をお選びください。モデルはご自身でご用意のうえ、それぞれのライセンスに沿ってお使いください（VRoid Studio でご自分で作ることもできます）。
        </p>
        <label v-if="hasCurrentVrm" class="choice">
          <input type="radio" :checked="vrmChoice.kind === 'keep'" @change="vrmChoice = { kind: 'keep' }" />
          今のまま（読み込んだファイル）
        </label>
        <label class="choice">
          <input type="radio" :checked="vrmChoice.kind === 'none'" @change="vrmChoice = { kind: 'none' }" />
          あとで追加する（モデルが無い間は、声と吹き出しだけで話します）
        </label>
        <label class="choice">
          <input type="radio" :checked="vrmChoice.kind === 'file'" disabled />
          ファイルを読み込む：
          <input type="file" accept=".vrm" @change="onFile" />
        </label>
        <p v-if="vrmChoice.kind === 'file'" class="notice">{{ vrmChoice.file.name }}</p>
        <p v-if="fileError" class="error">{{ fileError }}</p>
      </section>

      <footer>
        <p v-if="saveError" class="error">{{ saveError }}</p>
        <button @click="emit('close')">キャンセル</button>
        <button v-if="step > 1" @click="step = step === 3 ? 2 : 1">戻る</button>
        <button v-if="step === 1" class="primary" :disabled="!settingsReady" @click="step = 2">次へ</button>
        <button v-else-if="step === 2" class="primary" @click="openVoiceStep">次へ</button>
        <button v-else class="primary" :disabled="!settingsReady || saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgb(0 0 0 / 0.35);
}
.dialog {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  max-height: 100%;
  background: var(--card);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgb(0 0 0 / 0.25);
}
header,
footer {
  padding: 16px 20px;
}
header {
  border-bottom: 1px solid var(--border);
}
h2 {
  margin: 0 0 8px;
  font-size: 1.1rem;
}
.steps {
  display: flex;
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.85rem;
  color: var(--muted);
}
.steps .active {
  color: var(--accent);
  font-weight: 600;
}
.steps .later {
  opacity: 0.5;
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}
.icon-row {
  margin-bottom: 16px;
}
.generate {
  padding: 12px;
  margin-bottom: 16px;
  border-radius: 8px;
  background: var(--surface);
}
.generate label {
  display: block;
  margin-bottom: 6px;
  font-weight: 600;
  font-size: 0.9rem;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.85rem;
  color: var(--muted);
}
.grid .wide {
  grid-column: 1 / -1;
}
input:not([type='radio']):not([type='file']):not([type='checkbox']),
textarea {
  font: inherit;
  color: var(--text);
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card);
  width: 100%;
  box-sizing: border-box;
}
textarea {
  resize: vertical;
}
.images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.thumb {
  position: relative;
  margin: 0;
  width: 72px;
  height: 72px;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 6px;
}
.thumb button {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 50%;
  text-align: center;
  line-height: 1;
}
.add-image {
  display: flex;
  align-items: center;
  padding: 0 12px;
  height: 72px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
}
.source {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
  font-size: 0.85rem;
  color: var(--muted);
}
.source .hint {
  margin: 0;
}
.engine-error {
  display: flex;
  align-items: center;
  gap: 12px;
}
.engine-error .error {
  flex: 1;
  margin: 0;
}
.voice-select {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}
.voice-select select {
  flex: 1;
  font: inherit;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.slider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0;
}
.slider input {
  flex: 1;
}
.slider span {
  width: 2.5em;
  text-align: right;
}
.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 4px;
}
.check input {
  flex: none;
  width: auto;
  margin: 0;
}
footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--border);
}
footer .error {
  margin: 0 auto 0 0;
}
.hint,
.notice {
  font-size: 0.8rem;
  color: var(--muted);
}
.error {
  font-size: 0.85rem;
  color: var(--danger);
}
@media (max-width: 560px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>

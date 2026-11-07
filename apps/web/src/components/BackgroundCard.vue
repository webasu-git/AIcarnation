<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { DEFAULT_BACKGROUND_COLOR, type AgentBackground } from '@aicarnation/shared'
import AppIcon from './ui/AppIcon.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import { saveVrmFile } from '../db/vrmFiles'
import { useAgentsStore } from '../stores/agents'
import { useSettingsStore } from '../stores/settings'
import type { VrmViewer } from '../vrm/viewer'

/**
 * 選んでいるキャラクターの背景。単色か、画像・動画（壁紙やイラストなど、縦横比は自由）。
 * 画像・動画は縦横比を保ったままステージいっぱいに敷き、見せる位置・拡大・明るさ・ぼかしを調整できる。画像・動画は利用者が用意する
 */
const props = defineProps<{
  getViewer: () => VrmViewer | null
  /** 背景を読めなかったとき（ステージから知らされる） */
  error: string
  /** 読み込んだ画像・動画の大きさ（ピクセル） */
  size: { width: number; height: number }
}>()
const emit = defineEmits<{ 'clear-error': [] }>()

type ImageBackground = Extract<AgentBackground, { kind: 'image' }>

const agents = useAgentsStore()
const settings = useSettingsStore()

/** 背景色の見本。最後の「カスタム」は色を自由に選べる */
const SWATCHES = [
  { color: DEFAULT_BACKGROUND_COLOR, label: 'そら' },
  { color: '#f6efe6', label: 'ベージュ' },
  { color: '#e7f2ea', label: 'ミント' },
  { color: '#eee9f7', label: 'ラベンダー' },
  { color: '#ffffff', label: 'しろ' },
  { color: '#2b2f3a', label: 'よる' },
] as const
const KIND_OPTIONS = [
  { value: 'color', label: '単色' },
  { value: 'image', label: '画像・動画' },
] as const

const background = computed<AgentBackground>(() => agents.current?.backdrop ?? { kind: 'color', color: DEFAULT_BACKGROUND_COLOR })
/** 単色の色（画像にしている間も、戻したときのために覚えておく） */
const lastColor = ref(background.value.kind === 'color' ? background.value.color : DEFAULT_BACKGROUND_COLOR)
const image = computed(() => (background.value.kind === 'image' ? background.value : null))
/** 種類の切り替え。画像・動画がまだ無ければ、ファイルを選ぶまで単色のまま */
const kind = ref<'color' | 'image'>(background.value.kind)
watch(
  () => agents.current?.id,
  () => {
    kind.value = background.value.kind
    if (background.value.kind === 'color') lastColor.value = background.value.color
  },
)
const isCustomColor = computed(() => !SWATCHES.some((s) => s.color === lastColor.value))

/**
 * ふだんは今の背景を1行で見せ、「調整する」で詳しい設定を開く（設定の欄が長く、キャラクターのタブが縦に長くなるため）。
 * 開いているかはこの端末に覚える（この端末だけの便利のため。読めなければ閉じたまま）
 */
const OPEN_KEY = 'aicarnation:background-open'
function savedOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}
const open = ref(savedOpen())
watch(open, (value) => {
  try {
    localStorage.setItem(OPEN_KEY, value ? '1' : '0')
  } catch {
    // 覚えられなくても、開く・閉じるはそのまま使える
  }
})
const swatchLabel = computed(() => SWATCHES.find((s) => s.color === lastColor.value)?.label ?? lastColor.value)
const busy = ref(false)
const fileError = ref('')

async function save(next: AgentBackground) {
  const agent = agents.current
  if (!agent) return
  emit('clear-error')
  await agents.update(agent.id, { backdrop: next })
}

function pickColor(color: string) {
  lastColor.value = color
  void save({ kind: 'color', color })
}

watch(kind, (value) => {
  if (value === 'color' && background.value.kind !== 'color') void save({ kind: 'color', color: lastColor.value })
})

async function onImageFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const media = file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name) ? 'video' : 'image'
  if (media === 'image' && !file.type.startsWith('image/') && !/\.(jpe?g|png|webp|gif)$/i.test(file.name)) {
    fileError.value = '画像（jpg・png・webp）か動画（mp4・webm）をお選びください'
    return
  }
  fileError.value = ''
  busy.value = true
  try {
    const fileId = await saveVrmFile(file)
    // 見せ方は、替える前のものを引き継ぐ（同じ場面の画像を差し替えるときに、調整し直さずに済むように）
    const keep = image.value
    await save({
      kind: 'image',
      fileId,
      name: file.name,
      media,
      focusX: keep?.focusX ?? 0.5,
      focusY: keep?.focusY ?? 0.5,
      zoom: keep?.zoom ?? 1,
      brightness: keep?.brightness ?? 1,
      blur: keep?.blur ?? 0,
      parallax: keep?.parallax ?? false,
    })
  } finally {
    busy.value = false
  }
}

// 調整はスライダーを動かしている間はステージだけ変え、離したときに保存する（保存の回数を減らすため）。ぼかしは離したときに作り直す
const view = ref(pickView(image.value))
watch(image, (b) => (view.value = pickView(b)))
function pickView(b: ImageBackground | null) {
  return {
    focusX: b?.focusX ?? 0.5,
    focusY: b?.focusY ?? 0.5,
    zoom: b?.zoom ?? 1,
    brightness: b?.brightness ?? 1,
    blur: b?.blur ?? 0,
    parallax: b?.parallax ?? false,
  }
}
function previewView() {
  const { focusX, focusY, zoom, brightness, parallax } = view.value
  props.getViewer()?.setBackgroundView({ focusX, focusY, zoom, brightness, parallax })
}
function saveView() {
  const b = image.value
  if (b) void save({ ...b, ...view.value })
}

/** 小さい画像はステージに引き伸ばすとぼやけるので、目安を出す */
const sizeNote = computed(() => {
  const { width, height } = props.size
  if (!image.value || width === 0) return ''
  return Math.max(width, height) < 1280
    ? `画像が小さいため、ぼやけて見える場合があります（${width}×${height}）。長い辺が 1920 ピクセル以上の画像をおすすめします。`
    : ''
})
</script>

<template>
  <section class="card">
    <h2>
      <AppIcon name="image" />背景
      <span class="chip" :class="{ ok: !!image }">{{ image ? (image.media === 'video' ? '動画' : '画像') : '単色' }}</span>
    </h2>
    <div v-if="!open" class="summary">
      <span v-if="image" class="summary-text">{{ image.media === 'video' ? '動画' : '画像' }}：{{ image.name }}</span>
      <template v-else>
        <span class="summary-swatch" :style="{ background: lastColor }" aria-hidden="true" />
        <span class="summary-text">単色：{{ swatchLabel }}</span>
      </template>
      <button class="adjust" @click="open = true"><AppIcon name="sliders" :size="14" />調整する</button>
    </div>
    <template v-else>
      <SegmentedControl v-model="kind" :options="KIND_OPTIONS" label="背景の種類" />

      <div v-if="kind === 'color'" class="swatches" role="radiogroup" aria-label="背景色">
        <button
          v-for="s in SWATCHES"
          :key="s.color"
          class="swatch"
          role="radio"
          :aria-checked="lastColor === s.color"
          :aria-label="s.label"
          :title="s.label"
          :class="{ active: lastColor === s.color }"
          :style="{ background: s.color }"
          @click="pickColor(s.color)"
        />
        <label class="swatch custom" :class="{ active: isCustomColor }" title="好きな色を選ぶ">
          <input :value="lastColor" type="color" aria-label="好きな色を選ぶ" @change="pickColor(($event.target as HTMLInputElement).value)" />
        </label>
      </div>

      <template v-else>
        <p class="hint">
          画像（jpg・png・webp）か動画（mp4・webm）を、縦横比を保ったままステージいっぱいに表示します。壁紙やイラストなど、お好きなものをお使いいただけます。画像・動画はご自身でご用意のうえ、それぞれのライセンスに沿ってお使いください。
        </p>
        <label class="file-button" :class="{ disabled: busy }">
          <AppIcon name="download" :size="15" />{{ busy ? '読み込んでいます…' : image ? '別の画像・動画に替える' : '画像・動画を選ぶ' }}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm"
            hidden
            :disabled="busy"
            @change="onImageFile"
          />
        </label>
        <template v-if="image">
          <p class="hint">表示中：{{ image.name }}（{{ image.media === 'video' ? '動画' : '画像' }}）</p>
          <label class="slider">
            横の位置 <input v-model.number="view.focusX" type="range" min="0" max="1" step="0.01" @input="previewView" @change="saveView" />
            <span>{{ Math.round(view.focusX * 100) }}%</span>
          </label>
          <label class="slider">
            縦の位置 <input v-model.number="view.focusY" type="range" min="0" max="1" step="0.01" @input="previewView" @change="saveView" />
            <span>{{ Math.round(view.focusY * 100) }}%</span>
          </label>
          <label class="slider">
            拡大 <input v-model.number="view.zoom" type="range" min="1" max="3" step="0.05" @input="previewView" @change="saveView" />
            <span>{{ view.zoom.toFixed(2) }}</span>
          </label>
          <label class="slider">
            明るさ <input v-model.number="view.brightness" type="range" min="0.2" max="1.5" step="0.05" @input="previewView" @change="saveView" />
            <span>{{ view.brightness.toFixed(2) }}</span>
          </label>
          <label v-if="image.media === 'image'" class="slider">
            ぼかし <input v-model.number="view.blur" type="range" min="0" max="10" step="1" @change="saveView" />
            <span>{{ view.blur }}</span>
          </label>
          <ToggleSwitch v-model="view.parallax" @update:model-value="saveView">奥行き感（カメラを回すと背景が少しずれます）</ToggleSwitch>
          <ToggleSwitch v-if="image.media === 'video'" v-model="settings.backgroundPaused">
            背景の動きを止める（動画が重いときに。すべてのキャラクターに適用されます）
          </ToggleSwitch>
          <p v-if="sizeNote" class="hint warn">{{ sizeNote }}</p>
        </template>
      </template>
      <div class="blend">
        <p class="blend-title">背景になじませる（すべてのキャラクターに適用されます）</p>
        <label class="slider">
          足元の影 <input v-model.number="settings.groundShadow" type="range" min="0" max="1" step="0.05" />
          <span>{{ Math.round(settings.groundShadow * 100) }}%</span>
        </label>
        <label class="slider">
          背景の色の光 <input v-model.number="settings.backdropLight" type="range" min="0" max="1" step="0.05" />
          <span>{{ Math.round(settings.backdropLight * 100) }}%</span>
        </label>
        <p class="hint">背景の上のほう（空）の色を上から、下のほう（地面）の色を下から、アバターに当てます。0% にすると、これまでどおりの白い光になります。</p>
      </div>
      <button class="adjust done" @click="open = false">調整を閉じる</button>
    </template>
    <p v-if="agents.current?.missing?.backgroundFileName" class="hint">
      読み込んだ設定では、背景に「{{ agents.current.missing.backgroundFileName }}」を使っていました。同じ画像・動画をご用意のうえ、追加し直してください。
      <button type="button" class="dismiss-link" @click="agents.current && agents.dismissMissing(agents.current.id, 'backgroundFileName')">
        この案内を消す
      </button>
    </p>
    <p v-if="fileError" class="error">{{ fileError }}</p>
    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>

<style scoped>
h2 .chip {
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
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.82rem;
}
.summary-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.summary-swatch {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border: 1px solid var(--border);
  border-radius: 50%;
}
.adjust {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  font-size: 0.76rem;
  color: var(--text);
}
.adjust:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.adjust.done {
  margin-top: 12px;
}
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.swatch {
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  cursor: pointer;
}
.swatch.active {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.swatch.custom {
  position: relative;
  overflow: hidden;
  background: conic-gradient(#f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f472b6, #f87171);
}
.swatch.custom input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.blend {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.blend-title {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 600;
}
.warn {
  color: var(--warning, #b7791f);
}
.file-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 6px 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
  cursor: pointer;
}
.file-button.disabled {
  opacity: 0.5;
  pointer-events: none;
}
.slider {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0;
  font-size: 0.82rem;
}
.slider input {
  flex: 1;
}
.slider span {
  width: 3em;
  text-align: right;
}
</style>

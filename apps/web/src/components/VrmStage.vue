<script setup lang="ts">
import { markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DEFAULT_BACKGROUND_COLOR, type AgentBackground } from '@aicarnation/shared'
import { getVrmFile } from '../db/vrmFiles'
import { VrmViewer } from '../vrm/viewer'

const props = defineProps<{
  /** キャラクターの背景（無ければ既定の単色） */
  background: AgentBackground | undefined
  /** 動画の背景を止める */
  paused: boolean
  /** 足元の影の濃さ（0〜1） */
  shadow: number
  /** 背景の色をアバターの光に混ぜる強さ（0〜1） */
  backdropLight: number
}>()
const emit = defineEmits<{
  'background-error': [message: string]
  /** 読み込んだ画像・動画の大きさ（ピクセル。単色なら 0） */
  'background-size': [size: { width: number; height: number }]
}>()

const container = ref<HTMLElement | null>(null)
const viewer = markRaw(new VrmViewer())
/** 表示中の画像・動画のファイルとぼかし（見せ方だけが変わったときに読み直さないため） */
let shownFile = ''

async function applyBackground(bg: AgentBackground | undefined) {
  if (!bg || bg.kind === 'color') {
    shownFile = ''
    viewer.setBackgroundColor(bg?.color ?? DEFAULT_BACKGROUND_COLOR)
    emit('background-size', { width: 0, height: 0 })
    return
  }
  const view = { focusX: bg.focusX, focusY: bg.focusY, zoom: bg.zoom, brightness: bg.brightness, parallax: bg.parallax }
  // ぼかしは読み込むときにかけるので、ぼかしが変わったら読み直す
  const key = `${bg.fileId}:${bg.media === 'image' ? bg.blur : 0}`
  if (key === shownFile) {
    viewer.setBackgroundView(view)
    return
  }
  shownFile = key
  try {
    const record = await getVrmFile(bg.fileId)
    if (!record) throw new Error(`${bg.name} が見つかりません。お手数ですが、もう一度お選びください`)
    emit('background-size', await viewer.setBackgroundImage(record.blob, bg.media, view, bg.blur))
  } catch (err) {
    shownFile = ''
    viewer.setBackgroundColor(DEFAULT_BACKGROUND_COLOR)
    emit('background-error', err instanceof Error ? err.message : `${bg.name} を背景に設定できませんでした`)
  }
}

onMounted(() => {
  viewer.setBackgroundPaused(props.paused)
  viewer.setGroundShadow(props.shadow)
  viewer.setBackdropLight(props.backdropLight)
  void applyBackground(props.background)
  if (container.value) viewer.mount(container.value)
})

onBeforeUnmount(() => viewer.dispose())

watch(
  () => props.background,
  (bg) => void applyBackground(bg),
  { deep: true },
)
watch(
  () => props.paused,
  (paused) => viewer.setBackgroundPaused(paused),
)
watch(
  () => props.shadow,
  (v) => viewer.setGroundShadow(v),
)
watch(
  () => props.backdropLight,
  (v) => viewer.setBackdropLight(v),
)

defineExpose({ viewer })
</script>

<template>
  <div ref="container" class="vrm-stage" />
</template>

<style scoped>
.vrm-stage {
  position: absolute;
  inset: 0;
}
</style>

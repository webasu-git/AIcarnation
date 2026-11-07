<script setup lang="ts">
import { computed, ref } from 'vue'
import { ICON_IMAGE_ACCEPT, ICON_MAX_ZOOM, iconLayout, isIconImage, type IconView } from '../agents/iconLayout'

/**
 * キャラクターのアイコンの画像を選び、丸の中で位置と拡大を決める（編集画面の ① 設定のいちばん上）。
 * 丸の中の画像をドラッグして動かし、スライダー（またはホイール）で拡大する
 */
const props = defineProps<{
  /** 表示中の画像（無ければ頭文字の丸） */
  image: { url: string; width: number; height: number } | null
  view: IconView
  name: string
  color: string
  /** 読み込んだ設定でアイコンに使っていた画像のファイル名（まだ入っていないとき） */
  missingName?: string
}>()
const emit = defineEmits<{ pick: [file: File]; remove: []; 'update:view': [view: IconView] }>()

const SIZE = 112
const error = ref('')

const layout = computed(() => (props.image ? iconLayout(props.image.width, props.image.height, SIZE, props.view) : null))

function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!isIconImage(file)) {
    error.value = '画像（jpg・png・webp・gif・avif）をお選びください'
    return
  }
  error.value = ''
  emit('pick', file)
}

/** 位置と拡大を直す。丸にすき間ができない範囲に収めてから渡す */
function setView(next: IconView) {
  const img = props.image
  if (!img) return
  emit('update:view', iconLayout(img.width, img.height, SIZE, next).view)
}

// --- ドラッグで動かす ---
let drag: { pointerId: number; startX: number; startY: number; view: IconView } | null = null
function onPointerDown(e: PointerEvent) {
  if (!layout.value) return
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, view: { ...layout.value.view } }
}
function onPointerMove(e: PointerEvent) {
  const l = layout.value
  if (!drag || drag.pointerId !== e.pointerId || !l) return
  // 画像を指と同じだけ動かす＝丸の真ん中に来る画像の位置は、逆向きにずれる
  setView({
    x: drag.view.x - (e.clientX - drag.startX) / l.width,
    y: drag.view.y - (e.clientY - drag.startY) / l.height,
    zoom: drag.view.zoom,
  })
}
function onPointerUp(e: PointerEvent) {
  if (drag?.pointerId === e.pointerId) drag = null
}
function onWheel(e: WheelEvent) {
  if (!layout.value) return
  setView({ ...props.view, zoom: props.view.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08) })
}
function onZoom(e: Event) {
  setView({ ...props.view, zoom: Number((e.target as HTMLInputElement).value) })
}
</script>

<template>
  <div class="icon-picker">
    <div
      class="circle"
      :class="{ movable: !!layout }"
      :style="{ width: `${SIZE}px`, height: `${SIZE}px`, background: layout ? 'var(--surface)' : color }"
      :title="layout ? 'ドラッグで位置を、ホイールで大きさを変更できます' : ''"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel.prevent="onWheel"
    >
      <img
        v-if="image && layout"
        :src="image.url"
        alt=""
        draggable="false"
        :style="{ width: `${layout.width}px`, height: `${layout.height}px`, left: `${layout.left}px`, top: `${layout.top}px` }"
      />
      <span v-else class="initial">{{ name.slice(0, 1) || '？' }}</span>
    </div>
    <div class="controls">
      <span class="label">アイコンの画像</span>
      <div class="buttons">
        <label class="pick">
          {{ image ? '画像を替える' : '画像を選ぶ' }}
          <input type="file" :accept="ICON_IMAGE_ACCEPT" hidden @change="onFile" />
        </label>
        <button v-if="image" type="button" class="remove" @click="emit('remove')">外す</button>
      </div>
      <label v-if="image" class="zoom">
        大きさ
        <input type="range" min="1" :max="ICON_MAX_ZOOM" step="0.01" :value="view.zoom" @input="onZoom" />
      </label>
      <p class="hint">
        {{ image ? '丸の中の画像をドラッグして、表示する位置を調整できます。' : 'jpg・png・webp・gif・avif に対応しています。画像がない場合は、名前の頭文字を表示します。' }}
      </p>
      <p v-if="missingName" class="hint">
        読み込んだ設定では「{{ missingName }}」が使われていました。同じ画像を選ぶと、位置と大きさも元に戻ります。
      </p>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.icon-picker {
  display: flex;
  align-items: center;
  gap: 16px;
}
.circle {
  position: relative;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 50%;
  border: 1px solid var(--border);
  touch-action: none;
}
.circle.movable {
  cursor: grab;
}
.circle.movable:active {
  cursor: grabbing;
}
.circle img {
  position: absolute;
  max-width: none;
  pointer-events: none;
  user-select: none;
}
.initial {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  color: #fff;
  font-size: 2.4rem;
  font-weight: 700;
}
.controls {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.label {
  font-size: 0.85rem;
  font-weight: 600;
}
.buttons {
  display: flex;
  gap: 8px;
}
.pick,
.remove {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  font-size: 0.8rem;
  cursor: pointer;
}
.pick:hover,
.remove:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.zoom {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
}
.zoom input {
  flex: 1;
}
.hint {
  margin: 0;
  font-size: 0.76rem;
  color: var(--muted);
}
.error {
  margin: 0;
  font-size: 0.76rem;
  color: var(--danger);
}
</style>

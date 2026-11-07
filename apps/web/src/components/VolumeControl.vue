<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSettingsStore } from '../stores/settings'
import VolumeSlider from './ui/VolumeSlider.vue'

/**
 * 小窓の下のバーの音量ボタン（YouTube のように、普段はボタンだけ）。
 * - マウスを乗せると、ボタンの右に音量のスライドバーが伸びる（YouTube と同じ向き）。離すと少しして縮む
 * - ボタンが動かないよう、バーの左端に置く（伸びた分は右側の要素が縮んで吸収する）
 * - クリックすると、スライドバーを出したままにする。出ている間のクリックは読み上げのオン・オフ。
 *   外をクリックすると縮む（マウスを乗せられないタッチでも、1回目のクリックで出せる）
 */
const settings = useSettingsStore()
const root = ref<HTMLElement | null>(null)
const hovering = ref(false)
const pinned = ref(false)
const open = computed(() => hovering.value || pinned.value)

/** マウスを離してから縮めるまで（スライドバーへ移る間に縮まないように） */
const CLOSE_DELAY_MS = 500
let closeTimer: number | undefined

function win(): Window {
  return root.value?.ownerDocument.defaultView ?? window
}

function onEnter() {
  win().clearTimeout(closeTimer)
  hovering.value = true
}

function onLeave() {
  win().clearTimeout(closeTimer)
  closeTimer = win().setTimeout(() => (hovering.value = false), CLOSE_DELAY_MS)
}

function onButton() {
  if (!open.value) {
    pinned.value = true
    return
  }
  pinned.value = true
  settings.voiceEnabled = !settings.voiceEnabled
}

/** 出したままのときは、外をクリックしたら縮める（小窓に移っていれば小窓の document で見る） */
function onOutside(e: PointerEvent) {
  if (root.value && !root.value.contains(e.target as Node)) pinned.value = false
}

let listeningDoc: Document | null = null
watch(pinned, (value) => {
  listeningDoc?.removeEventListener('pointerdown', onOutside)
  listeningDoc = null
  if (value && root.value) {
    listeningDoc = root.value.ownerDocument
    listeningDoc.addEventListener('pointerdown', onOutside)
  }
})

onBeforeUnmount(() => {
  listeningDoc?.removeEventListener('pointerdown', onOutside)
  win().clearTimeout(closeTimer)
})
</script>

<template>
  <div
    ref="root"
    class="volume-control"
    :class="{ open }"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @focusin="onEnter"
    @focusout="onLeave"
  >
    <button
      type="button"
      class="voice"
      :class="{ off: !settings.voiceEnabled }"
      :aria-pressed="settings.voiceEnabled"
      :aria-expanded="open"
      :title="`${settings.voiceEnabled ? '読み上げ：オン' : '読み上げ：オフ'}・音量 ${Math.round(settings.volume * 100)}%`"
      @click="onButton"
    >
      {{ !settings.voiceEnabled ? '🔇' : settings.volume < 0.4 ? '🔉' : '🔊' }}
    </button>
    <div class="slider" :aria-hidden="!open">
      <VolumeSlider v-model="settings.volume" compact :disabled="!settings.voiceEnabled" />
    </div>
  </div>
</template>

<style scoped>
.volume-control {
  display: flex;
  align-items: center;
  gap: 0.3em;
}
/* 普段は幅 0 で隠し、開くと右へ伸ばす */
.slider {
  display: flex;
  align-items: center;
  width: 0;
  opacity: 0;
  overflow: hidden;
  transition:
    width 0.2s ease,
    opacity 0.2s ease;
}
.open .slider {
  width: 6.5em;
  opacity: 1;
  /* つまみが切れないよう、開いているときだけはみ出しを許す */
  overflow: visible;
  padding: 0 0.3em;
}
.slider :deep(.volume) {
  flex: 1;
}
/* ChatPanel のボタンと同じ見た目（文字の大きさに比例） */
.voice {
  font-size: 1em;
  padding: 0.4em 0.6em;
  border-radius: 0.6em;
  line-height: 1.2;
  min-width: 2.4em;
  text-align: center;
  border: 1px solid #dfe1ea;
  background: rgb(255 255 255 / 0.95);
  color: inherit;
  cursor: pointer;
}
.voice:hover {
  background: #fff;
}
.voice.off {
  opacity: 0.6;
}
</style>

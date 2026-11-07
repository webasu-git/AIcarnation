<script setup lang="ts">
import { computed } from 'vue'

/**
 * 音量のスライドバー（0〜1）。目盛りは 5% きざみで、右に今の値（%）を出す。
 * compact は小窓の下のバー用で、値の表示を省いて幅を詰める
 */
const model = defineModel<number>({ required: true })
defineProps<{ compact?: boolean; disabled?: boolean }>()

const percent = computed({
  get: () => Math.round(model.value * 100),
  set: (v: number) => {
    model.value = Math.min(100, Math.max(0, v)) / 100
  },
})
</script>

<template>
  <label class="volume" :class="{ compact, disabled }" :title="`音量 ${percent}%`">
    <span class="sr-only">音量</span>
    <input
      v-model.number="percent"
      type="range"
      min="0"
      max="100"
      step="5"
      :disabled="disabled"
      :aria-valuetext="`${percent}%`"
      :style="{ '--fill': `${percent}%` }"
    />
    <span v-if="!compact" class="value">{{ percent }}%</span>
  </label>
</template>

<style scoped>
.volume {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
.volume.disabled {
  opacity: 0.5;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
input {
  flex: 1;
  min-width: 0;
  height: 6px;
  margin: 0;
  appearance: none;
  border-radius: 999px;
  /* つまみの左側を色で塗る */
  background: linear-gradient(to right, var(--accent, #6366f1) var(--fill), #d6d8e3 var(--fill));
  cursor: pointer;
}
input::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--accent, #6366f1);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
}
input::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--accent, #6366f1);
}
.value {
  width: 3.2em;
  text-align: right;
  font-size: 0.82rem;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
/* 小窓の下のバー：文字の大きさ（em）に合わせて大きさを変える */
.compact {
  flex: 0 1 7em;
}
.compact input {
  height: 0.35em;
}
.compact input::-webkit-slider-thumb {
  width: 1em;
  height: 1em;
}
</style>

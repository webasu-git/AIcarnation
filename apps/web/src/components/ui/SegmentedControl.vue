<script setup lang="ts">
/** いくつかの選択肢から1つを選ぶ切り替えボタン */
const model = defineModel<string>({ required: true })
defineProps<{ options: readonly { value: string; label: string }[]; label: string }>()
</script>

<template>
  <div class="segmented" role="radiogroup" :aria-label="label">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="radio"
      :aria-checked="model === o.value"
      :class="{ active: model === o.value }"
      @click="model = o.value"
    >
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.segmented {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius-sm);
  background: var(--surface);
}
button {
  flex: 1;
  padding: 5px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 0.82rem;
  text-align: center;
}
button:hover:not(.active) {
  background: transparent;
  color: var(--text);
}
button.active {
  background: var(--card);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.1);
}
</style>

<script setup lang="ts">
/** オン・オフのスイッチ。ラベルは中身（slot）に書く */
const model = defineModel<boolean>({ required: true })
defineProps<{ disabled?: boolean }>()
</script>

<template>
  <label class="switch" :class="{ disabled }">
    <span class="text"><slot /></span>
    <input v-model="model" type="checkbox" role="switch" :disabled="disabled" />
    <span class="track" aria-hidden="true"><span class="thumb" /></span>
  </label>
</template>

<style scoped>
.switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  font-size: 0.88rem;
  cursor: pointer;
}
.switch.disabled {
  opacity: 0.5;
  cursor: default;
}
input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.track {
  position: relative;
  flex-shrink: 0;
  width: 38px;
  height: 22px;
  border-radius: 999px;
  background: var(--border);
  transition: background 0.2s;
}
.thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);
  transition: transform 0.2s;
}
input:checked + .track {
  background: var(--accent);
}
input:checked + .track .thumb {
  transform: translateX(16px);
}
input:focus-visible + .track {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>

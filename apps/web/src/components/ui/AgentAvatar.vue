<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentIcon } from '@aicarnation/shared'
import { iconLayout } from '../../agents/iconLayout'
import { loadIconImage, type LoadedIconImage } from '../../agents/iconImages'

/**
 * キャラクターの丸いアイコン。画像を入れていればその画像を、無ければ名前の頭文字を色の丸に出す。
 * 画像は、覚えた位置と拡大で丸の中に置く（agents/iconLayout.ts）
 */
const props = withDefaults(defineProps<{ icon?: AgentIcon; name: string; color: string; size?: number }>(), { size: 34 })

const image = ref<LoadedIconImage | null>(null)
watch(
  () => props.icon?.fileId,
  async (fileId) => {
    image.value = null
    if (!fileId) return
    const loaded = await loadIconImage(fileId)
    if (props.icon?.fileId === fileId) image.value = loaded
  },
  { immediate: true },
)

const layout = computed(() => {
  const img = image.value
  const icon = props.icon
  if (!img || !icon) return null
  return iconLayout(img.width, img.height, props.size, icon)
})
</script>

<template>
  <span class="agent-avatar" :style="{ width: `${size}px`, height: `${size}px`, background: layout ? 'var(--surface)' : color }">
    <img
      v-if="image && layout"
      :src="image.url"
      alt=""
      draggable="false"
      :style="{ width: `${layout.width}px`, height: `${layout.height}px`, left: `${layout.left}px`, top: `${layout.top}px` }"
    />
    <template v-else>{{ name.slice(0, 1) }}</template>
  </span>
</template>

<style scoped>
.agent-avatar {
  position: relative;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 50%;
  color: #fff;
  font-weight: 700;
}
.agent-avatar img {
  position: absolute;
  max-width: none;
  pointer-events: none;
  user-select: none;
}
</style>

<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './ui/AppIcon.vue'
import { openEditor } from './editorState'
import { setSetupGuideClosed, setupGuideClosed, setupGuideExpanded as expanded } from './setupGuideState'
import { isUntouchedDefault } from '../agents/defaultAgent'
import { useAgentsStore } from '../stores/agents'
import { parseEngineVoiceURI } from '../voice/engines'

/**
 * はじめての案内。素材はすべて利用者が入れるので、何をどの順に入れるかを見せる。
 * どれも飛ばしてよい（モデルが無ければ声と吹き出しで話し、声はブラウザの声、動きは標準の動きで動く）
 */
const props = defineProps<{ hasModel: boolean }>()
const emit = defineEmits<{ 'model-file': [file: File]; 'show-motions': [] }>()

const agents = useAgentsStore()
/** 閉じたかどうかはこの端末に覚える。「設定」タブからもう一度出せる */
function close() {
  setSetupGuideClosed(true)
}

const steps = computed(() => {
  const agent = agents.current
  return [
    { id: 'model', label: '3D モデル（.vrm）を追加', done: props.hasModel, optional: false },
    { id: 'persona', label: '人格を決める', done: !!agent && !isUntouchedDefault(agent), optional: false },
    { id: 'voice', label: '声を選ぶ（AivisSpeech）', done: !!agent && parseEngineVoiceURI(agent.voice.voiceURI) !== null, optional: false },
    {
      id: 'motion',
      label: '動きを追加（任意）',
      done: Object.values(agent?.motions ?? {}).some((l) => (l?.length ?? 0) > 0),
      optional: true,
    },
  ] as const
})
const allDone = computed(() => steps.value.every((s) => s.done || s.optional))
/** 準備が終わったら、案内は1行に縮める（場所を取らないように）。「手順を見る」で開く */
function expand() {
  expanded.value = true
}
function shrink() {
  expanded.value = false
}

function onModelFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) emit('model-file', file)
}
</script>

<template>
  <section v-if="!setupGuideClosed && agents.current && allDone && !expanded" class="card guide compact">
    <h2>
      <AppIcon name="flag" />準備ができました
      <button class="open" @click="expand">手順を見る</button>
      <button class="close" title="案内を閉じる" aria-label="案内を閉じる" @click="close">×</button>
    </h2>
  </section>
  <section v-else-if="!setupGuideClosed && agents.current" class="card guide">
    <h2>
      <AppIcon name="flag" />はじめに
      <button v-if="allDone" class="open" @click="shrink">1行にする</button>
      <button class="close" title="案内を閉じる" aria-label="案内を閉じる" @click="close">×</button>
    </h2>
    <p class="hint">
      このアプリには素材が含まれていません。下の順に、ご自分で用意されたものを追加してください。どの手順も飛ばしていただけます（標準の動きとブラウザの声で動きます）。
    </p>
    <ol class="steps">
      <li v-for="(s, i) in steps" :key="s.id" :class="{ done: s.done }">
        <span class="num">{{ s.done ? '✓' : i + 1 }}</span>
        <span class="label">{{ s.label }}</span>
        <label v-if="s.id === 'model'" class="step-button">
          {{ s.done ? '替える' : '選ぶ' }}
          <input type="file" accept=".vrm" hidden @change="onModelFile" />
        </label>
        <button v-else-if="s.id === 'persona'" class="step-button" @click="openEditor(agents.current, 1)">編集</button>
        <button v-else-if="s.id === 'voice'" class="step-button" @click="openEditor(agents.current, 3)">選ぶ</button>
        <button v-else class="step-button" @click="emit('show-motions')">見る</button>
      </li>
    </ol>
    <p v-if="allDone" class="hint">準備ができました。案内は右上の × で閉じられます（「設定」タブからいつでも再表示できます）。</p>
  </section>
</template>

<style scoped>
.guide.compact {
  padding-bottom: 14px;
}
.guide.compact h2 {
  margin: 0;
}
.guide h2 .open {
  margin-left: auto;
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  font-size: 0.74rem;
  font-weight: 500;
  color: var(--muted);
}
.guide h2 .open:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.guide h2 .open + .close {
  margin-left: 0;
}
.guide h2 .close {
  margin-left: auto;
  padding: 0 6px;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 1rem;
  line-height: 1;
}
.steps {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.steps li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 0.82rem;
}
.num {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--card);
  border: 1px solid var(--border);
  font-size: 0.72rem;
  font-weight: 700;
}
.done .num {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.done .label {
  color: var(--muted);
}
.label {
  flex: 1;
  min-width: 0;
}
.step-button {
  flex-shrink: 0;
  display: inline-block;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  font-size: 0.75rem;
  cursor: pointer;
}
</style>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { engineWarmup, installAivmModel, listAivmModels, restartEngine, uninstallAivmModel, type AivmModel } from '../voice/engines'
import { IS_COMPANION } from '../runtime'

/**
 * AivisSpeech の音声合成モデル（.aivmx）の管理。アプリは声を持たず、利用者が自分で用意したモデルを入れる。
 * 入れたモデルの声は、エージェントの「声」で選べるようになる
 */

const models = ref<AivmModel[]>([])
const state = ref<'loading' | 'ready' | 'error'>('loading')
const message = ref('')
const busy = ref(false)

async function load() {
  state.value = 'loading'
  message.value = ''
  // エンジンが起動していなければ起こし、起動を待つ
  if (!(await engineWarmup.warmUp('aivis'))) {
    state.value = 'error'
    message.value = IS_COMPANION
      ? 'AivisSpeech が起動していません。インストールされていない場合は、Claude Code で /aicarnation-voice install aivis を実行してください。'
      : 'AivisSpeech が起動していません。アプリを起動してから「もう一度確かめる」を押してください。'
    return
  }
  try {
    models.value = await listAivmModels()
    state.value = 'ready'
  } catch (err) {
    state.value = 'error'
    message.value = err instanceof Error ? err.message : 'モデルの一覧を読み込めませんでした'
  }
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.aivmx')) {
    message.value = `${file.name} は .aivmx ファイルではありません`
    return
  }
  busy.value = true
  message.value = `${file.name} を追加しています…`
  try {
    await installAivmModel(file)
    message.value = `${file.name} を追加しました。エージェントの「声」からお選びいただけます。`
    models.value = await listAivmModels()
  } catch (err) {
    message.value = err instanceof Error ? err.message : `${file.name} を追加できませんでした`
  } finally {
    busy.value = false
  }
}

async function remove(model: AivmModel) {
  busy.value = true
  message.value = ''
  try {
    await uninstallAivmModel(model.uuid)
    models.value = await listAivmModels()
    message.value = `${model.name} を外しました`
  } catch (err) {
    message.value = err instanceof Error ? err.message : 'モデルを外せませんでした'
  } finally {
    busy.value = false
  }
}

/** エンジンを起動し直す（同梱版だけ）。声のモデルの一覧が正しく出ないときに使う */
async function restart() {
  busy.value = true
  state.value = 'loading'
  message.value = ''
  try {
    if (!(await restartEngine('aivis'))) throw new Error('AivisSpeech が起動しませんでした')
    models.value = await listAivmModels()
    state.value = 'ready'
    message.value = 'AivisSpeech を再起動しました'
  } catch (err) {
    state.value = 'error'
    message.value = err instanceof Error ? err.message : 'AivisSpeech を再起動できませんでした'
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="voice-models">
    <p class="hint">
      AivisSpeech の音声合成モデル（.aivmx）を追加すると、その声で話せるようになります。モデルはご自分でご用意のうえ、それぞれのライセンスに沿ってお使いください。
    </p>
    <p v-if="state === 'loading'" class="hint">{{ busy ? 'AivisSpeech を再起動しています…（数十秒かかる場合があります）' : 'AivisSpeech を確認しています…' }}</p>
    <template v-else-if="state === 'error'">
      <p class="error">{{ message }}</p>
      <div class="actions">
        <button class="model-button" @click="load">もう一度確かめる</button>
        <button v-if="IS_COMPANION" class="model-button" @click="restart">AivisSpeech を再起動する</button>
      </div>
    </template>
    <template v-else>
      <ul class="models">
        <li v-for="m in models" :key="m.uuid" class="model-row">
          <div class="model-head">
            <span class="model-name" :title="m.uuid">{{ m.name }}<small v-if="m.isDefault">（最初から入っているモデル）</small></span>
            <button v-if="!m.isDefault" class="model-button" :disabled="busy" @click="remove(m)">外す</button>
          </div>
          <span v-if="m.isDefault" class="model-meta">AivisSpeech に最初から入っている声のため、外せません（起動するたびに入れ直されます）。</span>
          <span class="model-meta">ライセンス：{{ m.licenseName }}<template v-if="m.creators.length"> ／ 作者：{{ m.creators[0] }}<template v-if="m.creators.length > 1"> ほか</template></template></span>
          <details v-if="m.licenseText" class="license">
            <summary>ライセンスの全文</summary>
            <pre>{{ m.licenseText }}</pre>
          </details>
        </li>
        <li v-if="models.length === 0" class="hint">まだモデルが追加されていません。</li>
      </ul>
      <div class="actions">
        <label class="model-button add" :class="{ disabled: busy }">
          .aivmx を追加
          <input type="file" accept=".aivmx" hidden :disabled="busy" @change="onFile" />
        </label>
        <button
          v-if="IS_COMPANION"
          class="model-button"
          :disabled="busy"
          title="声のモデルの一覧が正しく出ないときに使います"
          @click="restart"
        >
          AivisSpeech を再起動する
        </button>
      </div>
      <p v-if="message" class="hint">{{ message }}</p>
    </template>
  </div>
</template>

<style scoped>
.models {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.model-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface);
}
.model-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.model-meta {
  font-size: 0.72rem;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.license summary {
  font-size: 0.72rem;
  color: var(--muted);
  cursor: pointer;
}
.license pre {
  max-height: 200px;
  overflow: auto;
  margin: 4px 0 0;
  padding: 6px;
  font-size: 0.7rem;
  white-space: pre-wrap;
  background: var(--card);
  border-radius: var(--radius-sm);
}
.model-name {
  flex: 1;
  min-width: 0;
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-name small {
  color: var(--muted);
  margin-left: 4px;
}
.model-button {
  flex-shrink: 0;
  display: inline-block;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  font-size: 0.78rem;
  cursor: pointer;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.model-button:disabled {
  opacity: 0.5;
  cursor: default;
}
.model-button.disabled {
  opacity: 0.5;
  pointer-events: none;
}
.hint {
  font-size: 0.78rem;
  color: var(--muted);
}
.error {
  font-size: 0.8rem;
  color: var(--danger, #c0392b);
}
</style>

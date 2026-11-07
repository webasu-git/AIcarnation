<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue'
import AppIcon from './ui/AppIcon.vue'
import AgentAvatar from './ui/AgentAvatar.vue'
import { avatarColor } from '../agents/avatarColor'
import { closeEditor, editorRequest, openEditor } from './editorState'
import { useAgentsStore } from '../stores/agents'
import { useChatStore } from '../stores/chat'

// 開いたときだけ要る部品は、あとから読み込む（最初の表示を軽くするため）
const AgentEditor = defineAsyncComponent(() => import('./AgentEditor.vue'))

const agents = useAgentsStore()
const chat = useChatStore()

const message = ref('')
const error = ref('')

function notify(text: string, isError = false) {
  message.value = isError ? '' : text
  error.value = isError ? text : ''
}

/** 読み上げ中ならエージェントの操作の前に止める */
async function select(id: string) {
  if (id === agents.current?.id || chat.streaming) return
  await chat.stopPerforming()
  await agents.select(id)
  notify('')
}

async function duplicate() {
  if (!agents.current) return
  await chat.stopPerforming()
  await agents.duplicate(agents.current.id)
  // 「（コピー）」の付いた名前のままにならないよう、名前の欄を選んだ状態で編集画面を開く
  if (agents.current) openEditor(agents.current, 1, true)
  notify('複製しました。お好きな名前に変えてから保存してください')
}

async function remove() {
  const target = agents.current
  if (!target) return
  if (!window.confirm(`「${target.name}」を削除してもよろしいですか？会話履歴も削除されます。`)) return
  await chat.stopPerforming()
  await agents.remove(target.id)
  notify(`「${target.name}」を削除しました`)
}

/** キャラクターを書き出す（設定だけ。3D モデル・動きのファイル・声のモデルは入らない） */
async function exportCurrent() {
  if (!agents.current) return
  const file = await agents.exportCharacter(agents.current.id)
  if (!file) return
  const url = URL.createObjectURL(new Blob([file.json], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = file.filename
  a.click()
  URL.revokeObjectURL(url)
  notify('書き出しました（設定のみです。3D モデル・動きのファイル・声のモデルは含まれていません）')
}

async function importFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    await chat.stopPerforming()
    // 書き出しファイルの読みの辞書は、書き出した PC の辞書なので、足すかどうかを確かめる
    const { agent, needs } = await agents.importCharacter(await file.text(), (words) =>
      window.confirm(
        [
          `この書き出しファイルには、読みの辞書の言葉が ${words.length} 語入っています（書き出した PC の辞書です）。`,
          `例：${words
            .slice(0, 5)
            .map((w) => `${w.surface}（${w.pronunciation}）`)
            .join('、')}${words.length > 5 ? ' など' : ''}`,
          '',
          'AivisSpeech の読みの辞書に追加しますか？（すでにある言葉は追加しません）',
        ].join('\n'),
      ),
    )
    notify(
      needs.length
        ? `「${agent.name}」を読み込みました。素材のファイルは含まれていないため、${needs.join('・')}をご自分でご用意のうえ、追加してください`
        : `「${agent.name}」を読み込みました`,
    )
  } catch (err) {
    notify(err instanceof Error ? err.message : String(err), true)
  }
}
</script>

<template>
  <section class="card">
    <div class="head">
      <h2><AppIcon name="character" />キャラクター</h2>
      <div class="head-actions">
        <label class="icon-button" title="書き出したキャラクターを読み込みます" :class="{ disabled: chat.streaming }">
          <AppIcon name="download" :size="16" />
          <input type="file" accept=".json,application/json" hidden :disabled="chat.streaming" @change="importFile" />
        </label>
        <button class="new" :disabled="chat.streaming" @click="openEditor(null)">
          <AppIcon name="plus" :size="16" />新しく作る
        </button>
      </div>
    </div>

    <ul class="list" role="listbox" aria-label="会話するキャラクター">
      <li
        v-for="a in agents.agents"
        :key="a.id"
        role="option"
        :aria-selected="a.id === agents.current?.id"
        :class="{ active: a.id === agents.current?.id, locked: chat.streaming }"
        tabindex="0"
        @click="select(a.id)"
        @keydown.enter.prevent="select(a.id)"
        @keydown.space.prevent="select(a.id)"
      >
        <AgentAvatar class="avatar" :icon="a.icon" :name="a.name" :color="avatarColor(a.id)" :size="34" />
        <span class="who">
          <span class="name">{{ a.name }}</span>
          <span class="sub">{{ a.personality || a.tone || 'まだ説明がありません' }}</span>
        </span>
        <AppIcon v-if="a.id === agents.current?.id" name="check" :size="16" class="mark" />
      </li>
    </ul>

    <div v-if="agents.current" class="actions">
      <button :disabled="chat.streaming" @click="openEditor(agents.current)"><AppIcon name="pencil" :size="15" />編集</button>
      <button :disabled="chat.streaming" @click="duplicate"><AppIcon name="copy" :size="15" />複製</button>
      <button title="設定だけを書き出します（素材のファイルは含まれません）" @click="exportCurrent"><AppIcon name="upload" :size="15" />書き出し</button>
      <button class="danger" :disabled="chat.streaming" title="削除" @click="remove">
        <AppIcon name="trash" :size="15" />
      </button>
    </div>
    <p v-if="message" class="hint">{{ message }}</p>
    <p v-if="error" class="error">{{ error }}</p>

    <AgentEditor
      v-if="editorRequest"
      :agent="editorRequest.agent ?? undefined"
      :initial-step="editorRequest.step"
      :focus-name="editorRequest.focusName"
      @close="closeEditor"
    />
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.head h2 {
  margin: 0;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.icon-button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  cursor: pointer;
}
.icon-button:hover {
  background: var(--surface);
  color: var(--text);
}
.icon-button.disabled {
  opacity: 0.45;
  cursor: default;
}
.new {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: none;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 0.82rem;
  font-weight: 600;
}
.new:hover:not(:disabled) {
  background: var(--accent-soft);
  filter: brightness(0.97);
}
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.list li:hover {
  background: var(--card-hover);
}
.list li.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.list li.locked:not(.active) {
  opacity: 0.5;
  cursor: default;
}
.avatar {
  font-size: 0.95rem;
}
.who {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.name {
  font-weight: 600;
  font-size: 0.9rem;
}
.sub {
  overflow: hidden;
  font-size: 0.76rem;
  color: var(--muted);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.mark {
  color: var(--accent);
}
.actions {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}
.actions button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  font-size: 0.8rem;
}
.actions .danger {
  margin-left: auto;
  color: var(--danger);
}
.actions .danger:hover:not(:disabled) {
  background: var(--danger-soft);
}
</style>

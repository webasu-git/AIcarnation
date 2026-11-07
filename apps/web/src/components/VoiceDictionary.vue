<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { AgentVoice } from '@aicarnation/shared'
import {
  addDictWord,
  engineWarmup,
  isKatakana,
  listDictWords,
  parseEngineVoiceURI,
  removeDictWord,
  toKatakana,
  updateDictWord,
  type DictWord,
} from '../voice/engines'
import { speak, stopSpeech } from '../voice/speech'
import { IS_COMPANION } from '../runtime'

/**
 * 読みの辞書（AivisSpeech のユーザー辞書）。固有名詞などの読み間違いを、表記と読みで登録する。
 * 登録した言葉は、どのエージェントの声でも、次に合成する文から効く
 */

const props = defineProps<{
  /** 試しに聞くときの声（選んでいるエージェントの声） */
  voice: AgentVoice | null
}>()

const words = ref<DictWord[]>([])
const state = ref<'loading' | 'ready' | 'error'>('loading')
const message = ref('')
const busy = ref(false)
/** 直している言葉（無ければ足す） */
const editing = ref<string | null>(null)
const form = reactive({ surface: '', pronunciation: '', accentType: 0 })

/** 試しに聞けるのは、選んでいるエージェントの声が AivisSpeech のときだけ（ブラウザの声には辞書が効かない） */
const canTry = computed(() => !!props.voice && parseEngineVoiceURI(props.voice.voiceURI) !== null)

async function load() {
  state.value = 'loading'
  message.value = ''
  if (!(await engineWarmup.warmUp('aivis'))) {
    state.value = 'error'
    message.value = IS_COMPANION
      ? 'AivisSpeech が起動していません。インストールされていない場合は、Claude Code で /aicarnation-voice install aivis を実行してください。'
      : 'AivisSpeech が起動していません。アプリを起動してから「もう一度確かめる」を押してください。'
    return
  }
  try {
    words.value = await listDictWords()
    state.value = 'ready'
  } catch (err) {
    state.value = 'error'
    message.value = err instanceof Error ? err.message : '辞書を読み込めませんでした'
  }
}

function resetForm() {
  editing.value = null
  form.surface = ''
  form.pronunciation = ''
  form.accentType = 0
}

function edit(word: DictWord) {
  editing.value = word.uuid
  form.surface = word.surface
  form.pronunciation = word.pronunciation
  form.accentType = word.accentType
  message.value = ''
}

/** 入力を確かめる。だめなら理由 */
function invalidReason(): string | null {
  const pronunciation = toKatakana(form.pronunciation)
  if (!form.surface.trim()) return '表記を入力してください'
  if (!pronunciation) return '読みを入力してください'
  if (!isKatakana(pronunciation)) return '読みはカタカナかひらがなで入力してください'
  if (!Number.isInteger(form.accentType) || form.accentType < 0) return 'アクセントは 0 以上の整数で入力してください'
  return null
}

async function save() {
  const reason = invalidReason()
  if (reason) {
    message.value = reason
    return
  }
  busy.value = true
  message.value = ''
  const word = { surface: form.surface.trim(), pronunciation: toKatakana(form.pronunciation), accentType: form.accentType }
  try {
    if (editing.value) await updateDictWord({ uuid: editing.value, ...word })
    else await addDictWord(word)
    message.value = `「${word.surface}」を「${word.pronunciation}」と読むように登録しました`
    resetForm()
    words.value = await listDictWords()
  } catch (err) {
    message.value = err instanceof Error ? err.message : '辞書に登録できませんでした'
  } finally {
    busy.value = false
  }
}

async function remove(word: DictWord) {
  busy.value = true
  message.value = ''
  try {
    await removeDictWord(word.uuid)
    if (editing.value === word.uuid) resetForm()
    words.value = await listDictWords()
    message.value = `「${word.surface}」を辞書から削除しました`
  } catch (err) {
    message.value = err instanceof Error ? err.message : '辞書から削除できませんでした'
  } finally {
    busy.value = false
  }
}

/** 表記を入れた文を、選んでいるエージェントの声で読む */
function tryWord(surface: string) {
  if (!props.voice || !surface.trim()) return
  stopSpeech()
  speak(`${surface.trim()}、と読みます。`, { ...props.voice })
}

onMounted(load)
</script>

<template>
  <div class="voice-dictionary">
    <p class="hint">
      AivisSpeech が読み間違える言葉（固有名詞など）の読みを登録できます。どのエージェントの声でも、次に話す文から反映されます。
    </p>
    <p v-if="state === 'loading'" class="hint">AivisSpeech を確認しています…</p>
    <template v-else-if="state === 'error'">
      <p class="error">{{ message }}</p>
      <button class="dict-button" @click="load">もう一度確かめる</button>
    </template>
    <template v-else>
      <ul class="words">
        <li v-for="w in words" :key="w.uuid" class="word-row" :class="{ editing: editing === w.uuid }">
          <span class="word-text" :title="`アクセント ${w.accentType}`">{{ w.surface }}<small>{{ w.pronunciation }}</small></span>
          <button v-if="canTry" class="dict-button" @click="tryWord(w.surface)">聞く</button>
          <button class="dict-button" :disabled="busy" @click="edit(w)">直す</button>
          <button class="dict-button" :disabled="busy" @click="remove(w)">消す</button>
        </li>
        <li v-if="words.length === 0" class="hint">まだ登録された言葉はありません。</li>
      </ul>
      <div class="form">
        <label>
          表記
          <input v-model="form.surface" type="text" placeholder="例：東雲" />
        </label>
        <label>
          読み（カタカナ）
          <input v-model="form.pronunciation" type="text" placeholder="例：シノノメ" />
        </label>
        <label class="accent">
          アクセント
          <input v-model.number="form.accentType" type="number" min="0" step="1" />
        </label>
      </div>
      <p class="hint">アクセントは、音が下がる直前の拍の番号です（0 は下がらない、1 は最初の拍のあとで下がる）。分からない場合は 0 のままで構いません。</p>
      <div class="actions">
        <button class="dict-button primary" :disabled="busy" @click="save">{{ editing ? '直す' : '登録する' }}</button>
        <button v-if="editing" class="dict-button" :disabled="busy" @click="resetForm">やめる</button>
        <button v-if="canTry" class="dict-button" :disabled="!form.surface.trim()" @click="tryWord(form.surface)">いまの読みを聞く</button>
      </div>
      <p v-if="!canTry" class="hint">お選びのエージェントの声が AivisSpeech のときは、ここから試しにお聞きいただけます。</p>
      <p v-if="message" class="hint">{{ message }}</p>
    </template>
  </div>
</template>

<style scoped>
.words {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow: auto;
}
.word-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface);
}
.word-row.editing {
  outline: 1px solid var(--border);
}
.word-text {
  flex: 1;
  min-width: 0;
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.word-text small {
  color: var(--muted);
  margin-left: 8px;
}
.form {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.form label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 120px;
  font-size: 0.75rem;
  color: var(--muted);
}
.form label.accent {
  flex: 0 0 80px;
}
.form input {
  min-width: 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dict-button {
  flex-shrink: 0;
  display: inline-block;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  font-size: 0.78rem;
  cursor: pointer;
}
.dict-button.primary {
  font-weight: 600;
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

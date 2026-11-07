<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from './ui/AppIcon.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import { useAgentsStore } from '../stores/agents'
import { MOTION_ROLE_INFO, type useMotionLibrary } from '../motion/useMotionLibrary'
import { isMotionFileName, roleFromFileName } from '../motion/roleFromName'
import type { MotionRole } from '../vrm/motion/clips'
import type { VrmViewer } from '../vrm/viewer'

/**
 * 選んでいるキャラクターの動き。役ごとに1つずつ入れるほか、複数のファイルやフォルダをまとめて入れると、
 * ファイル名の先頭の印（「(待機)Idle.fbx」など）で役に振り分ける。印の無いファイルは役を選んでもらう
 */
const props = defineProps<{
  library: ReturnType<typeof useMotionLibrary>
  getViewer: () => VrmViewer | null
}>()

const agents = useAgentsStore()
const dropRole = ref<MotionRole | null>(null)
const draggingAll = ref(false)
const busy = ref(false)
const message = ref('')
/** 役が決まらなかったファイル（選んでもらう） */
const pending = ref<{ file: File; role: MotionRole | '' }[]>([])

const motionsOf = (role: MotionRole) => agents.current?.motions?.[role] ?? []
/** 読み込んだキャラクターで使っていて、まだ入っていない動き（同じ名前のファイルを入れると、その役に入る） */
const expected = computed(() => agents.current?.missing?.motions ?? [])
const ROLE_LABEL = new Map(MOTION_ROLE_INFO.map((r) => [r.role as string, r.label]))
const roleCount = computed(() => MOTION_ROLE_INFO.filter((r) => motionsOf(r.role).length > 0).length)

function onRoleFile(role: MotionRole, e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void props.library.assign(role, file)
}

function onRoleDrop(role: MotionRole, e: DragEvent) {
  dropRole.value = null
  draggingAll.value = false
  const files = [...(e.dataTransfer?.files ?? [])]
  // 役の行に複数落とされたら、その役にまとめて入れる
  if (files.length > 0) void addFiles(files.map((file) => ({ file, role })))
}

/** 振り分けを決めたファイルを順に入れる */
async function addFiles(list: { file: File; role: MotionRole }[]) {
  busy.value = true
  try {
    for (const { file, role } of list) await props.library.assign(role, file)
  } finally {
    busy.value = false
  }
}

/** まとめて渡されたファイルを、ファイル名の印で振り分ける */
async function importMany(files: File[]) {
  const motionFiles = files.filter((f) => isMotionFileName(f.name))
  const skipped = files.length - motionFiles.length
  const known: { file: File; role: MotionRole }[] = []
  for (const file of motionFiles) {
    // 読み込んだキャラクターで同じ名前のファイルを使っていれば、その役に入れる（1つのファイルを複数の役で使っていたら、それぞれに）
    const roles = expected.value.filter((m) => m.name === file.name).map((m) => m.role as MotionRole)
    const role = roleFromFileName(file.name)
    if (roles.length) for (const r of roles) known.push({ file, role: r })
    else if (role) known.push({ file, role })
    else pending.value.push({ file, role: '' })
  }
  await addFiles(known)
  const parts = [`${known.length} 個を役に振り分けて追加しました`]
  if (pending.value.length) parts.push(`${pending.value.length} 個は役をお選びください`)
  if (skipped) parts.push(`動きのファイルではない ${skipped} 個はスキップしました`)
  message.value = parts.join('。') + '。'
}

function onManyFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (files.length) void importMany(files)
}

function onCardDrop(e: DragEvent) {
  draggingAll.value = false
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length) void importMany(files)
}

async function addPending() {
  const ready = pending.value.filter((p): p is { file: File; role: MotionRole } => p.role !== '')
  pending.value = pending.value.filter((p) => p.role === '')
  await addFiles(ready)
  message.value = `${ready.length} 個を追加しました。`
}
</script>

<template>
  <section
    class="card"
    :class="{ dragging: draggingAll }"
    @dragover.prevent="draggingAll = true"
    @dragleave.self="draggingAll = false"
    @drop.prevent="onCardDrop"
  >
    <h2>
      <AppIcon name="motion" />動き
      <span class="chip" :class="{ ok: roleCount > 0 }">{{ roleCount > 0 ? `${roleCount} / ${MOTION_ROLE_INFO.length} の役` : '標準の動き' }}</span>
    </h2>
    <p class="hint">
      このキャラクターの動きです。VRM アニメーション（.vrma）か Mixamo の FBX（.fbx）を役に追加すると、その動きで動きます。1つの役に複数追加した場合は、そのたびにランダムで選ばれます。追加していない役は、標準の小さな動き（呼吸・視線・重心の移動・表情など）で動きます。
    </p>

    <div class="talk-gestures">
      <ToggleSwitch
        :model-value="agents.current?.talkGestures !== false"
        @update:model-value="(on: boolean) => agents.current && agents.update(agents.current.id, { talkGestures: on })"
      >
        話すときに手ぶりをする
      </ToggleSwitch>
      <p class="hint">
        話している間、両手を開いて見せる手ぶりをします。モデルによって手が体や服にめり込む場合は、オフにしてください（「話している」の役に動きのファイルを追加した場合は、そちらが優先されます）。
      </p>
    </div>

    <div class="bulk">
      <label class="motion-button" :class="{ disabled: busy }">
        まとめて追加
        <input type="file" accept=".vrma,.fbx" multiple hidden :disabled="busy" @change="onManyFiles" />
      </label>
      <label class="motion-button" :class="{ disabled: busy }">
        フォルダから追加
        <input type="file" webkitdirectory multiple hidden :disabled="busy" @change="onManyFiles" />
      </label>
    </div>
    <p class="hint">
      ファイル名の先頭に「(待機)」「(考える)」「(作業中)」「(話す)」「(挨拶)」「(喜ぶ)」「(気まぐれ)」の印を付けておくと、自動で役に振り分けます。このカードにドロップして入れることもできます。
    </p>
    <div v-if="expected.length" class="expected">
      <p class="pending-title">読み込んだ設定で使っていた動きが {{ expected.length }} 個あります（まだ入っていません）</p>
      <p class="hint">
        同じ名前のファイルを「まとめて追加」で追加すると、元の役に入ります。使わない場合は、この案内を消せます。
        <button type="button" class="dismiss-link" @click="agents.current && agents.dismissMissing(agents.current.id, 'motions')">
          この案内を消す
        </button>
      </p>
      <details>
        <summary>ファイル名の一覧</summary>
        <ul>
          <li v-for="(m, i) in expected" :key="i">
            <span class="motion-file" :title="m.name">{{ m.name }}</span>
            <span class="motion-hint">{{ ROLE_LABEL.get(m.role) ?? m.role }}</span>
          </li>
        </ul>
      </details>
    </div>
    <p v-if="busy" class="hint">読み込んでいます…</p>
    <p v-else-if="message" class="hint">{{ message }}</p>

    <div v-if="pending.length" class="pending">
      <p class="pending-title">役をお選びください</p>
      <div v-for="(p, i) in pending" :key="i" class="pending-row">
        <span class="motion-file" :title="p.file.name">{{ p.file.name }}</span>
        <select v-model="p.role" :aria-label="`${p.file.name} の役`">
          <option value="">選ぶ</option>
          <option v-for="info in MOTION_ROLE_INFO" :key="info.role" :value="info.role">{{ info.label }}</option>
        </select>
        <button class="motion-button" @click="pending.splice(i, 1)">やめる</button>
      </div>
      <button class="motion-button" :disabled="busy || pending.every((p) => p.role === '')" @click="addPending">選んだ役に追加</button>
    </div>

    <ul class="motions">
      <li
        v-for="info in MOTION_ROLE_INFO"
        :key="info.role"
        class="motion-row"
        :class="{ over: dropRole === info.role }"
        @dragover.prevent.stop="dropRole = info.role"
        @dragleave="dropRole = null"
        @drop.prevent.stop="onRoleDrop(info.role, $event)"
      >
        <div class="motion-head">
          <div class="motion-text">
            <span class="motion-label">
              {{ info.label }}
              <span v-if="motionsOf(info.role).length" class="motion-count">{{ motionsOf(info.role).length }}</span>
            </span>
            <span class="motion-hint">{{ info.hint }}</span>
          </div>
          <label class="motion-button" :title="`${info.label}の動きのパターンを追加します（複数ある場合はランダムで選ばれます）`">
            {{ motionsOf(info.role).length ? '足す' : '選ぶ' }}
            <input type="file" accept=".vrma,.fbx" hidden @change="onRoleFile(info.role, $event)" />
          </label>
        </div>
        <span v-if="library.errors[info.role]" class="error">{{ library.errors[info.role] }}</span>
        <p v-if="!motionsOf(info.role).length" class="motion-empty">入っていません（標準の動きで動きます）</p>
        <ul v-else class="motion-files">
          <li v-for="m in motionsOf(info.role)" :key="m.fileId" class="motion-file-row">
            <span class="motion-file" :title="m.name">{{ m.name }}</span>
            <button class="motion-button small" :title="`${m.name} を1回再生して確認します`" @click="getViewer()?.previewMotion(info.role, m.fileId)">
              再生
            </button>
            <button class="motion-button small" @click="library.remove(info.role, m.fileId)">外す</button>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.card.dragging {
  outline: 2px dashed var(--accent);
  outline-offset: -4px;
}
h2 .chip {
  margin-left: auto;
}
.chip {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 600;
  white-space: nowrap;
}
.chip.ok {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.talk-gestures {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.talk-gestures .hint {
  margin: 0;
}
.bulk {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.expected {
  margin-top: 10px;
  padding: 8px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--border);
}
.expected ul {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.expected li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pending {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  padding: 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
.pending-title {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 600;
}
.pending-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pending-row select {
  flex-shrink: 0;
  font-size: 0.78rem;
}
.pending > .motion-button {
  align-self: flex-start;
}
.motions {
  list-style: none;
  margin: 14px 0 0;
  padding: 14px 0 0;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.motion-row {
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  border: 1px dashed transparent;
  border-radius: var(--radius-sm);
  background: var(--surface);
}
.motion-row.over {
  border-color: var(--accent);
}
.motion-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.motion-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.92rem;
  font-weight: 700;
}
.motion-count {
  min-width: 1.4em;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 0.7rem;
  font-weight: 600;
  text-align: center;
}
.motion-head,
.motion-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.motion-files {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.motion-files .motion-file-row {
  padding: 6px 0;
}
.motion-files .motion-file-row + .motion-file-row {
  border-top: 1px solid var(--border);
}
.motion-files .motion-file {
  color: var(--text);
  font-size: 0.82rem;
}
.motion-empty {
  margin: 10px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 0.76rem;
  color: var(--muted);
}
.motion-hint {
  font-size: 0.76rem;
  line-height: 1.45;
  color: var(--muted);
}
.motion-file {
  flex: 1;
  min-width: 0;
  font-size: 0.75rem;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.motion-button {
  flex-shrink: 0;
  display: inline-block;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  font-size: 0.78rem;
  cursor: pointer;
}
.motion-button.small {
  padding: 2px 10px;
  font-size: 0.74rem;
}
.motion-button.disabled {
  opacity: 0.5;
  pointer-events: none;
}
</style>

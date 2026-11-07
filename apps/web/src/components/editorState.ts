import { ref } from 'vue'
import type { AgentDefinition } from '@aicarnation/shared'

/** エージェントの編集画面の開き方。どこからでも開けるように、ここで1つだけ持つ */
export type EditorStep = 1 | 2 | 3

/** null: 閉じている / agent が null: 新しく作る / 定義: その段から編集。focusName は名前の欄を選んだ状態で開く（複製した直後など） */
export const editorRequest = ref<{ agent: AgentDefinition | null; step: EditorStep; focusName?: boolean } | null>(null)

export function openEditor(agent: AgentDefinition | null, step: EditorStep = 1, focusName = false): void {
  editorRequest.value = { agent, step, focusName }
}

export function closeEditor(): void {
  editorRequest.value = null
}

import type { ChatMessage, Emotion } from '@aicarnation/shared'
import { idbDeleteByIndex, idbGetAllByIndex, idbPut } from './idb'

/** messages ストアのレコード */
export interface MessageRecord extends ChatMessage {
  agentId: string
  seq: number
  emotion: Emotion | null
  createdAt: string
}

export async function loadMessages(agentId: string): Promise<MessageRecord[]> {
  const records = await idbGetAllByIndex<MessageRecord>('messages', 'agentId', agentId)
  return records.sort((a, b) => a.seq - b.seq)
}

export async function saveMessage(record: MessageRecord): Promise<void> {
  await idbPut('messages', record)
}

/** そのエージェントの履歴だけを消す */
export async function clearMessages(agentId: string): Promise<void> {
  await idbDeleteByIndex('messages', 'agentId', agentId)
}

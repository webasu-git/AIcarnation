import type { AgentDefinition } from '@aicarnation/shared'
import { idbDelete, idbGetAll, idbPut } from './idb'

export async function loadAgents(): Promise<AgentDefinition[]> {
  const list = await idbGetAll<AgentDefinition>('agents')
  return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function saveAgent(agent: AgentDefinition): Promise<void> {
  await idbPut('agents', agent)
}

export async function deleteAgent(id: string): Promise<void> {
  await idbDelete('agents', id)
}

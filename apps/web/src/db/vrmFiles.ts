import { idbDelete, idbGet, idbPut } from './idb'

interface VrmFileRecord {
  id: string
  name: string
  blob: Blob
}

export async function saveVrmFile(file: File): Promise<string> {
  const id = crypto.randomUUID()
  await idbPut<VrmFileRecord>('vrmFiles', { id, name: file.name, blob: file })
  return id
}

export async function getVrmFile(id: string): Promise<VrmFileRecord | undefined> {
  return idbGet<VrmFileRecord>('vrmFiles', id)
}

export async function deleteVrmFile(id: string): Promise<void> {
  await idbDelete('vrmFiles', id)
}

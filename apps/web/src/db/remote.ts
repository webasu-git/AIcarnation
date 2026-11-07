import { companionHeaders } from '../runtime'
import type { StoreName } from './idb'

/**
 * 同梱版の保存先：同梱サーバー（プラグインのフォルダ）。
 * ブラウザの保存領域はポート（オリジン）ごとに別になるので使わない。IndexedDB 版（idb.ts）と同じ形で読み書きする
 */

/** ストアごとのキーの作り方（IndexedDB の keyPath と同じ） */
const KEY_OF: Record<StoreName, (value: never) => string> = {
  agents: (v: { id: string }) => v.id,
  vrmFiles: (v: { id: string }) => v.id,
  settings: (v: { key: string }) => v.key,
  messages: (v: { agentId: string; seq: number }) => `${v.agentId}:${v.seq}`,
}

function keyString(key: IDBValidKey): string {
  return Array.isArray(key) ? key.map(String).join(':') : String(key)
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { ...init, headers: { ...companionHeaders(), ...init.headers } })
  if (!res.ok && res.status !== 404) throw new Error(`保存できませんでした（${res.status}）`)
  return res
}

interface VrmFileValue {
  id: string
  name: string
  blob: Blob
}

export async function remoteGet<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const k = encodeURIComponent(keyString(key))
  if (name === 'vrmFiles') {
    const res = await call(`/files/vrm/${k}`)
    if (res.status === 404) return undefined
    const fileName = decodeURIComponent(res.headers.get('x-file-name') ?? `${keyString(key)}.vrm`)
    return { id: keyString(key), name: fileName, blob: await res.blob() } as T
  }
  const res = await call(`/store/${name}/${k}`)
  return res.status === 404 ? undefined : ((await res.json()) as T)
}

export async function remotePut<T>(name: StoreName, value: T): Promise<void> {
  const key = encodeURIComponent(KEY_OF[name](value as never))
  if (name === 'vrmFiles') {
    const file = value as unknown as VrmFileValue
    await call(`/files/vrm/${key}`, { method: 'PUT', headers: { 'x-file-name': encodeURIComponent(file.name) }, body: file.blob })
    return
  }
  await call(`/store/${name}/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })
}

export async function remoteDelete(name: StoreName, key: IDBValidKey): Promise<void> {
  const k = encodeURIComponent(keyString(key))
  await call(name === 'vrmFiles' ? `/files/vrm/${k}` : `/store/${name}/${k}`, { method: 'DELETE' })
}

export async function remoteGetAll<T>(name: StoreName): Promise<T[]> {
  return (await (await call(`/store/${name}`)).json()) as T[]
}

export async function remoteGetAllByField<T>(name: StoreName, field: string, value: string): Promise<T[]> {
  const all = await remoteGetAll<Record<string, unknown>>(name)
  return all.filter((v) => v[field] === value) as T[]
}

export async function remoteDeleteByField(name: StoreName, field: string, value: string): Promise<void> {
  const query = new URLSearchParams({ field, value })
  await call(`/store/${name}?${query}`, { method: 'DELETE' })
}

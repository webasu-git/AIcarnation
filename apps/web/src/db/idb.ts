/**
 * IndexedDB の薄いラッパー。
 * 同梱版（IS_COMPANION）は同じ形で同梱サーバー（プラグインのフォルダ）に保存する（remote.ts）
 */
import { IS_COMPANION } from '../runtime'
import {
  remoteDelete,
  remoteDeleteByField,
  remoteGet,
  remoteGetAll,
  remoteGetAllByField,
  remotePut,
} from './remote'

const DB_NAME = 'aicarnation'
const DB_VERSION = 1

export type StoreName = 'agents' | 'vrmFiles' | 'messages' | 'settings'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('agents', { keyPath: 'id' })
      db.createObjectStore('vrmFiles', { keyPath: 'id' })
      const messages = db.createObjectStore('messages', { keyPath: ['agentId', 'seq'] })
      messages.createIndex('agentId', 'agentId')
      db.createObjectStore('settings', { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbPromise = null
      reject(req.error)
    }
  })
  return dbPromise
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function store(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb()
  return db.transaction(name, mode).objectStore(name)
}

export async function idbGet<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
  if (IS_COMPANION) return remoteGet<T>(name, key)
  return promisify((await store(name, 'readonly')).get(key))
}

export async function idbPut<T>(name: StoreName, value: T): Promise<void> {
  if (IS_COMPANION) return remotePut(name, value)
  await promisify((await store(name, 'readwrite')).put(value))
}

export async function idbDelete(name: StoreName, key: IDBValidKey): Promise<void> {
  if (IS_COMPANION) return remoteDelete(name, key)
  await promisify((await store(name, 'readwrite')).delete(key))
}

export async function idbGetAll<T>(name: StoreName): Promise<T[]> {
  if (IS_COMPANION) return remoteGetAll<T>(name)
  return promisify((await store(name, 'readonly')).getAll())
}

/** インデックス（名前は値のフィールド名と同じ）が key のものを全部取る */
export async function idbGetAllByIndex<T>(name: StoreName, index: string, key: string): Promise<T[]> {
  if (IS_COMPANION) return remoteGetAllByField<T>(name, index, key)
  return promisify((await store(name, 'readonly')).index(index).getAll(key))
}

/** インデックスが key のものを全部消す */
export async function idbDeleteByIndex(name: StoreName, index: string, key: string): Promise<void> {
  if (IS_COMPANION) return remoteDeleteByField(name, index, key)
  const keys = await promisify((await store(name, 'readonly')).index(index).getAllKeys(key))
  const s = await store(name, 'readwrite')
  await Promise.all(keys.map((k) => promisify(s.delete(k))))
}

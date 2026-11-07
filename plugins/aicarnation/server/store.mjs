// 画面の保存データ（エージェント・設定・履歴・読み込んだ VRM）を、保存先フォルダ（--data）に置く。
// ブラウザの保存領域はポート（オリジン）ごとに別になるので使わず、どのブラウザ・どのポートで開いても同じデータを見る。
//
//   <data>/agents.json・settings.json・messages.json・lines.json（台詞帳） … { キー: 値 } の JSON
//   <data>/vrm/<id>.vrm と <id>.json                   … 読み込んだ VRM と、そのファイル名
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const STORES = ['agents', 'settings', 'messages', 'lines']
const KEY_PATTERN = /^[\w.:-]{1,200}$/

export function isStoreName(name) {
  return STORES.includes(name)
}

export function isKey(key) {
  return KEY_PATTERN.test(key)
}

export function createStore(dataDir) {
  /** 読み込んだストア：name → Map。最初に使うときにファイルから読む */
  const cache = new Map()
  /** 書き込みは1つずつ順に行う（同時に書くとファイルが壊れるため） */
  let writing = Promise.resolve()

  async function load(name) {
    let map = cache.get(name)
    if (map) return map
    map = new Map()
    try {
      const raw = JSON.parse(await readFile(join(dataDir, `${name}.json`), 'utf8'))
      for (const [k, v] of Object.entries(raw ?? {})) map.set(k, v)
    } catch {
      // まだ無い・壊れている：空から始める
    }
    cache.set(name, map)
    return map
  }

  /** 一時ファイルに書いてから置き換える（途中で止まっても前のデータが残る） */
  function save(name, map) {
    const body = JSON.stringify(Object.fromEntries(map))
    writing = writing
      .then(async () => {
        await mkdir(dataDir, { recursive: true })
        const file = join(dataDir, `${name}.json`)
        await writeFile(`${file}.tmp`, body)
        await rename(`${file}.tmp`, file)
      })
      .catch(() => undefined)
    return writing
  }

  const vrmDir = join(dataDir, 'vrm')

  return {
    async getAll(name) {
      return [...(await load(name)).values()]
    },
    async get(name, key) {
      return (await load(name)).get(key)
    },
    async put(name, key, value) {
      const map = await load(name)
      map.set(key, value)
      await save(name, map)
    },
    async delete(name, key) {
      const map = await load(name)
      map.delete(key)
      await save(name, map)
    },
    /** 値の field が value に等しいものをまとめて消す（エージェントの履歴を消すときなど） */
    async deleteWhere(name, field, value) {
      const map = await load(name)
      for (const [k, v] of map) if (v?.[field] === value) map.delete(k)
      await save(name, map)
    },
    async putVrm(id, fileName, data) {
      await mkdir(vrmDir, { recursive: true })
      await writeFile(join(vrmDir, `${id}.vrm`), data)
      await writeFile(join(vrmDir, `${id}.json`), JSON.stringify({ name: fileName }))
    },
    async getVrm(id) {
      try {
        const meta = JSON.parse(await readFile(join(vrmDir, `${id}.json`), 'utf8'))
        return { name: String(meta.name ?? `${id}.vrm`), data: await readFile(join(vrmDir, `${id}.vrm`)) }
      } catch {
        return null
      }
    },
    async deleteVrm(id) {
      await rm(join(vrmDir, `${id}.vrm`), { force: true })
      await rm(join(vrmDir, `${id}.json`), { force: true })
    },
  }
}

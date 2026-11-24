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

  /**
   * 保存ファイルを読む。無ければ空から始める。壊れていれば、そのファイルを別の名前で残してから空から始める（中身を失わない）。
   * それ以外で読めないとき（ほかのアプリがファイルを使っているなど）は失敗を返し、覚えない（次の問い合わせで読み直す）。
   * 一時的に読めなかっただけで空と覚えると、画面が「データが無い」と判断して、保存済みのデータを上書きしてしまう。
   * 読み込み中の Promise も覚えて分け合う（同時に読むと別々の中身ができ、片方の保存が消えるため）
   */
  function load(name) {
    const cached = cache.get(name)
    if (cached) return cached
    const loading = readMap(name)
    cache.set(name, loading)
    // 読めなかったら覚えない（次の問い合わせで読み直す）
    loading.catch(() => {
      if (cache.get(name) === loading) cache.delete(name)
    })
    return loading
  }

  async function readMap(name) {
    const map = new Map()
    const file = join(dataDir, `${name}.json`)
    let text = null
    try {
      text = await readFile(file, 'utf8')
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
    if (text === null) return map
    let parsed
    try {
      parsed = JSON.parse(text) ?? {}
    } catch {
      // 壊れたファイルは別の名前で残す。残せなければ失敗を返す（空で始めると、次の保存で壊れたファイルの中身が消える）
      await replace(file, join(dataDir, `${name}.broken-${Date.now()}.json`))
      return map
    }
    for (const [k, v] of Object.entries(parsed)) map.set(k, v)
    return map
  }

  /** ファイルを置き換える。Windows では、ほかのアプリ（ウイルス対策など）が一瞬つかんでいて失敗することがあるので、少し待って試し直す */
  async function replace(from, to) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await rename(from, to)
      } catch (err) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
      }
    }
  }

  /**
   * 一時ファイルに書いてから置き換える（途中で止まっても前のデータが残る）。
   * 失敗したら失敗を返す（画面が保存できなかったと分かるように）。そのときは覚えている中身を捨て、次はファイルから読み直す
   */
  function save(name, map) {
    const body = JSON.stringify(Object.fromEntries(map))
    const done = writing.then(async () => {
      await mkdir(dataDir, { recursive: true })
      const file = join(dataDir, `${name}.json`)
      await writeFile(`${file}.tmp`, body)
      await replace(`${file}.tmp`, file)
    })
    // 次の書き込みは、この書き込みが失敗しても続ける
    writing = done.catch(() => undefined)
    return done.catch((err) => {
      // 覚えている中身はファイルとずれたので、読み直す。ただし、すでに並んでいる書き込みが終わってから読む
      // （先に読むと、そのあと書かれる分を含まない中身で、次の保存が上書きしてしまう）
      const reload = writing.then(() => readMap(name))
      cache.set(name, reload)
      reload.catch(() => {
        if (cache.get(name) === reload) cache.delete(name)
      })
      throw err
    })
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

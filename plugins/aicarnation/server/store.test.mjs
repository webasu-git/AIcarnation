import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store.mjs'

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'aicarnation-store-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('保存して、別のサーバー（読み直し）からも読める', () =>
  withDir(async (dir) => {
    await createStore(dir).put('settings', 'volume', { key: 'volume', value: 0.3 })
    assert.deepEqual(await createStore(dir).get('settings', 'volume'), { key: 'volume', value: 0.3 })
  }))

test('一時的に読めないときは失敗を返し、空と覚えない（あとで読めれば中身が見える）', () =>
  withDir(async (dir) => {
    // settings.json がフォルダになっている＝読めない状態を作る
    await mkdir(join(dir, 'agents.json'))
    const store = createStore(dir)
    await assert.rejects(store.getAll('agents'))
    // 読めない間に保存しようとしても、空の中身で上書きしない
    await assert.rejects(store.put('agents', 'a', { id: 'a' }))
    // 読めるようになったら、ファイルの中身が見える
    await rm(join(dir, 'agents.json'), { recursive: true })
    await writeFile(join(dir, 'agents.json'), JSON.stringify({ x: { id: 'x' } }))
    assert.deepEqual(await store.getAll('agents'), [{ id: 'x' }])
  }))

test('壊れたファイルは別の名前で残してから、空から始める', () =>
  withDir(async (dir) => {
    await writeFile(join(dir, 'agents.json'), '{ 壊れた')
    const store = createStore(dir)
    assert.deepEqual(await store.getAll('agents'), [])
    const names = await readdir(dir)
    const broken = names.find((n) => n.startsWith('agents.broken-'))
    assert.ok(broken, names.join(','))
    assert.equal(await readFile(join(dir, broken), 'utf8'), '{ 壊れた')
  }))

test('書けなかったら失敗を返し、覚えている中身を捨てる（次はファイルから読む）', () =>
  withDir(async (dir) => {
    const store = createStore(dir)
    await store.put('settings', 'a', 1)
    // 一時ファイルの場所をフォルダにして、書けない状態を作る
    await mkdir(join(dir, 'settings.json.tmp'))
    await assert.rejects(store.put('settings', 'b', 2))
    await rm(join(dir, 'settings.json.tmp'), { recursive: true })
    // 失敗した値は残らず、ファイルにある値だけが見える。次の保存はできる
    assert.equal(await store.get('settings', 'b'), undefined)
    assert.equal(await store.get('settings', 'a'), 1)
    await store.put('settings', 'c', 3)
    assert.equal(await createStore(dir).get('settings', 'c'), 3)
  }))

test('保存の失敗のあとに別々の保存が同時に届いても、どちらも残る（読み込みを分け合う）', () =>
  withDir(async (dir) => {
    const store = createStore(dir)
    await store.put('settings', 'a', 1)
    await mkdir(join(dir, 'settings.json.tmp'))
    await assert.rejects(store.put('settings', 'b', 2))
    await rm(join(dir, 'settings.json.tmp'), { recursive: true })
    await Promise.all([store.put('settings', 'x', 10), store.put('settings', 'y', 20)])
    const fresh = createStore(dir)
    assert.equal(await fresh.get('settings', 'x'), 10)
    assert.equal(await fresh.get('settings', 'y'), 20)
    assert.equal(await fresh.get('settings', 'a'), 1)
  }))

test('はじめての読み込みが同時に走っても、中身は1つ', () =>
  withDir(async (dir) => {
    await writeFile(join(dir, 'agents.json'), JSON.stringify({ a: { id: 'a' } }))
    const store = createStore(dir)
    await Promise.all([store.put('agents', 'b', { id: 'b' }), store.put('agents', 'c', { id: 'c' })])
    assert.deepEqual((await createStore(dir).getAll('agents')).map((v) => v.id).sort(), ['a', 'b', 'c'])
  }))

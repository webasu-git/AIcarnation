import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePicked, pickCommand, pickFolder } from './pick-folder.mjs'

test('OS ごとに、システムのコマンドを名指しで使う', () => {
  const win = pickCommand('win32', { SystemRoot: 'C:/Windows' })
  assert.match(win.file.replaceAll('/', '|').replaceAll(String.fromCharCode(92), '|'), /^C:\|Windows\|System32\|WindowsPowerShell\|v1.0\|powershell.exe$/)
  assert.ok(win.args.includes('-STA'))
  assert.deepEqual(pickCommand('darwin').file, '/usr/bin/osascript')
  assert.equal(pickCommand('linux'), null)
})

test('選ばれたフォルダの場所を取り出す', () => {
  assert.equal(parsePicked('D:/work/app/' + String.fromCharCode(10)), 'D:/work/app')
  assert.equal(parsePicked('/Users/me/app/'), '/Users/me/app')
  assert.equal(parsePicked('C:/'), 'C:/')
  assert.equal(parsePicked('/'), '/')
  assert.equal(parsePicked(''), null)
  assert.equal(parsePicked(undefined), null)
})

test('窓は同時に1つだけ。やめたときは選ばなかったことにする', async (t) => {
  if (!pickCommand()) return t.skip('この OS では窓を開けない')
  let finish
  const run = (file, args, options, done) => {
    assert.equal(options.env.AICARNATION_PICK_PROMPT, '選んでください')
    finish = done
  }
  const first = pickFolder('選んでください', run)
  assert.deepEqual(await pickFolder('もう1つ', run), { error: 'フォルダを選ぶ窓が、もう開いています' })
  finish(null, 'D:/work/app')
  assert.deepEqual(await first, { path: 'D:/work/app' })
  // 終わったら、また開ける。失敗で終わった（やめた）ときは null
  const second = pickFolder('選んでください', run)
  finish(new Error('cancelled'), '')
  assert.deepEqual(await second, { path: null })
})

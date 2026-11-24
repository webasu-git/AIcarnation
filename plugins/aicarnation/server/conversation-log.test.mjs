// node --test plugins/aicarnation/server
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { cleanText, createConversationLog, localStamp, retentionDays, splitEmotions, toRecord, MAX_LOG_TEXT } from './conversation-log.mjs'

// このファイルのテストは日本時間で走らせる（Node は実行中に TZ を変えると従う）。ほかのタイムゾーンは子プロセスで確かめる
process.env.TZ = 'Asia/Tokyo'

test('動いている PC のタイムゾーンで日付と時刻を切る', () => {
  // UTC 15:30 は日本時間の翌日 0:30
  assert.deepEqual(localStamp(new Date('2026-11-22T15:30:05Z')), { day: '2026-11-23', ts: '2026-11-23T00:30:05+09:00' })
})

test('ほかのタイムゾーンでは、その土地の日付と時差になる', () => {
  const run = (tz) =>
    JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', `import { localStamp } from ${JSON.stringify(new URL('./conversation-log.mjs', import.meta.url).href)}; console.log(JSON.stringify(localStamp(new Date('2026-11-22T15:30:05Z'))))`], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      }),
    )
  assert.deepEqual(run('America/New_York'), { day: '2026-11-22', ts: '2026-11-22T10:30:05-05:00' })
  assert.deepEqual(run('UTC'), { day: '2026-11-22', ts: '2026-11-22T15:30:05+00:00' })
  assert.deepEqual(run('Asia/Kolkata'), { day: '2026-11-22', ts: '2026-11-22T21:00:05+05:30' })
})

test('返事を感情タグごとに分ける', () => {
  assert.deepEqual(splitEmotions('[happy] よかった。[sad] でも少しさみしい。'), [
    { emotion: 'happy', text: 'よかった。' },
    { emotion: 'sad', text: 'でも少しさみしい。' },
  ])
  assert.deepEqual(splitEmotions('タグなし'), [{ emotion: 'neutral', text: 'タグなし' }])
  assert.deepEqual(splitEmotions('[unknown] そのまま'), [{ emotion: 'neutral', text: '[unknown] そのまま' }])
})

test('発言から内部メモとタグを消し、長すぎれば切る', () => {
  assert.equal(cleanText('<system-reminder>秘密</system-reminder>こんにちは <b>世界</b>'), 'こんにちは 世界')
  const long = cleanText('あ'.repeat(MAX_LOG_TEXT + 50))
  assert.equal(long.length, MAX_LOG_TEXT + 1)
})

test('合図を記録の1行にする', () => {
  const date = new Date('2026-11-22T17:46:12Z')
  assert.deepEqual(toRecord({ type: 'listening', text: '片付けた' }, date), { ts: '2026-11-23T02:46:12+09:00', type: 'heard', text: '片付けた' })
  assert.deepEqual(toRecord({ type: 'reply', text: '[relaxed] 了解よ。' }, date), {
    ts: '2026-11-23T02:46:12+09:00',
    type: 'reply',
    emotion: 'relaxed',
    text: '了解よ。',
  })
  const multi = toRecord({ type: 'reply', text: '[happy] やったわ。[neutral] 次はテストね。' }, date)
  assert.equal(multi.text, 'やったわ。 次はテストね。')
  assert.equal(multi.segments.length, 2)
  assert.equal(toRecord({ type: 'working', label: '作業中' }, date), null)
  assert.equal(toRecord({ type: 'listening', text: '<system-reminder>x</system-reminder>' }, date), null)
})

test('残す日数を収める', () => {
  assert.equal(retentionDays(undefined), 30)
  assert.equal(retentionDays(0), 30)
  assert.equal(retentionDays(7), 7)
  assert.equal(retentionDays(1000), 365)
})

test('日付ごとのファイルに追記し、古い日のファイルを消す', async () => {
  const data = await mkdtemp(join(tmpdir(), 'aicarnation-log-'))
  try {
    let now = new Date('2026-11-23T01:00:00Z') // 日本時間 11/23 10:00
    const log = createConversationLog(data, () => now)
    await mkdir(log.dir, { recursive: true })
    await writeFile(join(log.dir, '2026-11-16.jsonl'), '{}\n') // 8日前：消える
    await writeFile(join(log.dir, '2026-11-17.jsonl'), '{}\n') // 7日前（今日を入れて7日）：残る
    await writeFile(join(log.dir, 'memo.txt'), 'x') // 記録でないファイルは触らない

    await log.append({ type: 'listening', text: 'おはよう' }, 7)
    await log.append({ type: 'reply', text: '[happy] おはよう。' }, 7)
    await log.append({ type: 'idle' }, 7)

    const lines = (await readFile(join(log.dir, '2026-11-23.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(
      lines.map((l) => l.type),
      ['heard', 'reply'],
    )
    assert.deepEqual((await readdir(log.dir)).sort(), ['2026-11-17.jsonl', '2026-11-23.jsonl', 'memo.txt'])

    // 日が変わると、次の記録の前にもう一度古いものを消す
    now = new Date('2026-11-24T01:00:00Z')
    await log.append({ type: 'listening', text: '翌日' }, 7)
    assert.deepEqual((await readdir(log.dir)).sort(), ['2026-11-23.jsonl', '2026-11-24.jsonl', 'memo.txt'])
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})

test('記録に残す前に、秘密らしき文字列を伏せる（切れ目にかかっても残らない）', () => {
  const date = new Date('2026-11-22T17:46:12Z')
  assert.equal(toRecord({ type: 'listening', text: 'キーは sk-ant-abc123DEF456ghi789 です' }, date).text, 'キーは [REDACTED] です')
  assert.equal(toRecord({ type: 'reply', text: '[happy] token=abcdef123456 を使ったわ。' }, date).text, 'token=[REDACTED] を使ったわ。')
  // 伏せるのは切る前：上限の切れ目にまたがる長い英数字も、途中までが残らない
  const secret = 'a1'.repeat(40)
  const cut = cleanText(`${'あ'.repeat(MAX_LOG_TEXT - 20)}${secret}`)
  assert.equal(cut.includes('a1a1'), false)
  assert.equal(cut.endsWith('[REDACTED]'), true)
})

test('長くて意地の悪い入力でも、整形がすぐ終わる', () => {
  const inputs = [
    '<system-reminder>'.repeat(200_000), // 閉じていない内部メモが大量
    `x${' \t'.repeat(500_000)}y`, // 改行のない空白の長い並び
    '<a '.repeat(300_000), // 閉じていないタグが大量
    `token${' '.repeat(500_000)}=`, // 名前の後ろの空白が長い
  ]
  for (const input of inputs) {
    const started = performance.now()
    cleanText(input)
    assert.ok(performance.now() - started < 500, `整形に時間がかかりすぎ（${input.slice(0, 12)}…）`)
  }
  // 内部メモは、閉じているものだけ中身ごと消す。似た名前のタグは対象外
  assert.equal(cleanText('前<system-reminder a="1">秘密</system-reminder>後 <system-reminder>閉じていない'), '前 後 閉じていない')
  assert.equal(cleanText('a\n\n  b  \n\t\nc'), 'a\nb\nc')
})

test('残す日数の設定を読めなかったとき（null）は、古い記録を消さない', async () => {
  const data = await mkdtemp(join(tmpdir(), 'aicarnation-log-null-'))
  try {
    const now = new Date(2026, 10, 23, 9, 0, 0)
    const log = createConversationLog(data, () => now)
    await mkdir(log.dir, { recursive: true })
    await writeFile(join(log.dir, '2026-01-01.jsonl'), '{}\n')
    await log.prune(null)
    await log.append({ type: 'listening', text: 'おはよう' }, null)
    assert.ok((await readdir(log.dir)).includes('2026-01-01.jsonl'))
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TZ = 'Asia/Tokyo'
const { collectMaterials, redact, validateSuggestion } = await import('./proactive.mjs')

test('秘密の文字列らしきものを伏せ字にする', () => {
  assert.equal(redact('キーは sk-ant-abc123DEF456ghi789 です'), 'キーは [REDACTED] です')
  assert.equal(redact('xoxb-1234567890-abcdefghij と ghp_abcdefghijklmnopqrstuvwx1234'), '[REDACTED] と [REDACTED]')
  assert.equal(redact('http://127.0.0.1:48280/?token=0123456789abcdef0123456789abcdef'), 'http://127.0.0.1:48280/?token=[REDACTED]')
  assert.equal(redact('password: hunter2hunter2'), 'password: [REDACTED]')
  assert.equal(redact('ハッシュ 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'), 'ハッシュ [REDACTED]')
  // ふつうの文章・短い英数字・数字を含まない長い単語は残す
  assert.equal(redact('検索の索引を v2 に作り直す案'), '検索の索引を v2 に作り直す案')
  assert.equal(redact('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
})

test('提案の答えを検証する', () => {
  assert.deepEqual(validateSuggestion({ propose: true, emotion: 'relaxed', text: '[relaxed] 続きを組んでみないかしら？\n', reason: '昨日の検討' }), {
    propose: true,
    emotion: 'relaxed',
    text: '続きを組んでみないかしら？',
    reason: '昨日の検討',
  })
  assert.deepEqual(validateSuggestion({ propose: false, reason: '話題が無い' }), { propose: false, reason: '話題が無い' })
  assert.equal(validateSuggestion(null).propose, false)
  assert.equal(validateSuggestion({ text: 'あ', emotion: 'happy' }).propose, false)
  assert.equal(validateSuggestion({ propose: true, emotion: 'happy', text: '' }).propose, false)
  assert.equal(validateSuggestion({ propose: true, emotion: 'happy', text: 'あ'.repeat(121) }).propose, false)
  assert.equal(validateSuggestion({ propose: true, emotion: 'joy', text: 'あ' }).propose, false)
  assert.equal(validateSuggestion({ propose: 'true', emotion: 'happy', text: 'あ' }).propose, false)
})

test('材料を集める：直近の数日・上限・伏せ字・話した提案だけ', async () => {
  const data = await mkdtemp(join(tmpdir(), 'aicarnation-proactive-'))
  try {
    const dir = join(data, 'logs', 'conversation')
    await mkdir(dir, { recursive: true })
    const line = (o) => `${JSON.stringify(o)}\n`
    await writeFile(join(dir, '2026-11-20.jsonl'), line({ ts: '2026-11-20T10:00:00+09:00', type: 'heard', text: '古すぎる話' }))
    await writeFile(
      join(dir, '2026-11-22.jsonl'),
      line({ ts: '2026-11-22T21:00:00+09:00', type: 'heard', text: '検索を速くする検討。キーは sk-ant-abc123DEF456ghi789' }) +
        '壊れた行\n' +
        line({ ts: '2026-11-22T21:00:05+09:00', type: 'reply', emotion: 'relaxed', text: '索引を足す案ね。' }),
    )
    await writeFile(join(dir, '2026-11-23.jsonl'), line({ ts: '2026-11-23T09:00:00+09:00', type: 'heard', text: 'おはよう\n今日もよろしく' }))
    await writeFile(
      join(data, 'logs', 'suggestions.jsonl'),
      line({ ts: '2026-11-22T22:00:00+09:00', propose: true, spoken: true, text: '続きを組まない？' }) +
        line({ ts: '2026-11-22T23:00:00+09:00', propose: false, spoken: false, text: '' }) +
        line({ ts: '2026-11-22T23:30:00+09:00', propose: true, spoken: false, text: '話さなかった提案' }),
    )
    const now = new Date('2026-11-23T01:30:00Z') // 日本時間 11/23（月）10:30
    const m = await collectMaterials(data, {}, now)
    assert.equal(m.now, '2026-11-23（月）10:30')
    assert.equal(
      m.conversation,
      ['[11/22 21:00 ユーザー] 検索を速くする検討。キーは [REDACTED]', '[11/22 21:00 アバター] 索引を足す案ね。', '[11/23 09:00 ユーザー] おはよう 今日もよろしく'].join('\n'),
    )
    assert.equal(m.suggestions, '[11/22 22:00] 続きを組まない？')
    assert.equal(m.lines, 3)

    // 行数の上限は新しいものを残す。文字数の上限は古いものから削る
    assert.equal((await collectMaterials(data, { conversationMaxLines: 1 }, now)).conversation, '[11/23 09:00 ユーザー] おはよう 今日もよろしく')
    assert.equal((await collectMaterials(data, { maxContextChars: 60 }, now)).lines, 1)

    // 記録が無くても空で返る
    const empty = await collectMaterials(join(data, 'none'), {}, now)
    assert.deepEqual([empty.conversation, empty.suggestions, empty.lines], ['', '', 0])
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})

test('出さない時間帯（日をまたぐものも）', async () => {
  const { inQuietHours } = await import('./proactive.mjs')
  const at = (h, m = 0) => new Date(2026, 10, 23, h, m)
  assert.equal(inQuietHours(['23:00-07:00'], at(23, 30)), true)
  assert.equal(inQuietHours(['23:00-07:00'], at(6, 59)), true)
  assert.equal(inQuietHours(['23:00-07:00'], at(7)), false)
  assert.equal(inQuietHours(['12:00-13:00'], at(12, 30)), true)
  assert.equal(inQuietHours(['12:00-13:00', 'でたらめ'], at(14)), false)
  assert.equal(inQuietHours([], at(3)), false)
})

test('出す頻度：既定では間隔も 1 日の回数も制限しない。設定したときだけ、話した提案を数えて止める', async () => {
  const { gateReason, gateOptions } = await import('./proactive.mjs')
  const now = new Date('2026-11-23T03:00:00Z') // 日本時間 12:00
  const spoken = (ts) => ({ ts, propose: true, spoken: true })
  const many = Array.from({ length: 30 }, (_, i) => spoken(`2026-11-23T${String(Math.floor(i / 3)).padStart(2, '0')}:${String((i % 3) * 20).padStart(2, '0')}:00+09:00`))

  // 既定：直前に話していても、今日すでに何度話していても、止めない
  assert.equal(gateReason([], {}, now), null)
  assert.equal(gateReason([spoken('2026-11-23T11:59:00+09:00')], {}, now), null)
  assert.equal(gateReason(many, {}, now), null)
  assert.deepEqual(gateOptions(undefined, 'x', 'y'), { cooldownMin: 0, maxPerDay: Infinity, quietHours: [] })

  // 間隔を設定したとき
  const cool = { cooldownMin: 60 }
  assert.match(gateReason([spoken('2026-11-23T11:30:00+09:00')], cool, now), /60 分/)
  assert.equal(gateReason([spoken('2026-11-23T10:59:00+09:00')], cool, now), null)
  // 話さなかった提案・「提案なし」は数えない
  assert.equal(gateReason([{ ts: '2026-11-23T11:59:00+09:00', propose: true, spoken: false }, { ts: '2026-11-23T11:59:30+09:00', propose: false, spoken: false }], cool, now), null)

  // 1 日の回数を設定したとき
  const cap = { maxPerDay: 8 }
  const eight = many.slice(0, 8)
  assert.match(gateReason(eight, cap, now), /上限/)
  assert.equal(gateReason(eight.slice(0, 7), cap, now), null)
  // 昨日の分は数えない
  assert.equal(gateReason(eight.map((r) => ({ ...r, ts: r.ts.replace('11-23', '11-22') })), cap, now), null)

  // 出さない時間帯は、設定したときだけ
  assert.match(gateReason([], { quietHours: ['11:00-13:00'] }, now), /時間帯/)
  assert.deepEqual(gateOptions(30, 3, ['23:00-07:00', 1]), { cooldownMin: 30, maxPerDay: 3, quietHours: ['23:00-07:00'] })
})

test('提案の記録：話したあと 5 分以内の発言で「反応があった」になる', async () => {
  const { createSuggestionLog } = await import('./proactive.mjs')
  const data = await mkdtemp(join(tmpdir(), 'aicarnation-suggest-'))
  try {
    let now = new Date('2026-11-23T01:00:00Z')
    const log = createSuggestionLog(data, () => now)
    await log.append({ propose: false, reason: '話題が無い' }, false)
    await log.userSpoke() // 話していないので何も変わらない
    await log.append({ propose: true, emotion: 'relaxed', text: '続きをやらない？', reason: '昨日の検討' }, true)
    now = new Date('2026-11-23T01:04:00Z')
    await log.userSpoke()
    let records = await log.read()
    assert.deepEqual(
      records.map((r) => [r.propose, r.spoken, r.user_responded_within_5min]),
      [
        [false, false, false],
        [true, true, true],
      ],
    )
    assert.equal(records[1].ts, '2026-11-23T10:00:00+09:00')

    // 5 分を過ぎた発言は数えない
    now = new Date('2026-11-23T03:00:00Z')
    await log.append({ propose: true, emotion: 'happy', text: 'お茶にしない？', reason: '' }, true)
    now = new Date('2026-11-23T03:06:00Z')
    await log.userSpoke()
    records = await log.read()
    assert.equal(records[2].user_responded_within_5min, false)
    assert.equal(records.length, 3)
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})

test('提案の文に URL・ファイルの場所・コマンドが入っていたら出さない', () => {
  for (const text of [
    'https://example.com を開いてみない？',
    'example.com を見てみて',
    String.raw`C:\Users\me\a.txt を消してみたら？`,
    '~/work/app/ を見直そう',
    '`rm -rf` で片付けよう',
    'npm install foo してみない？',
    'curl -s で試してみて',
    'cat a | grep b してみよう',
  ]) {
    assert.equal(validateSuggestion({ propose: true, emotion: 'neutral', text, reason: 'x' }).propose, false, text)
  }
  // ふつうの話し言葉は通る
  assert.equal(validateSuggestion({ propose: true, emotion: 'happy', text: '昨日の続き、git の整理から始めてみない？', reason: 'x' }).propose, true)
})

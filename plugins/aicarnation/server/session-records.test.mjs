import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TZ = 'Asia/Tokyo'
const { collectSessionTurns, extractTurns, projectFolderName } = await import('./session-records.mjs')
const { collectMaterials } = await import('./proactive.mjs')

const line = (o) => `${JSON.stringify(o)}\n`
const user = (ts, content, extra = {}) => line({ type: 'user', timestamp: ts, message: { role: 'user', content }, ...extra })
const claude = (ts, content, extra = {}) => line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content }, ...extra })

test('プロジェクトのフォルダから、記録のフォルダ名を求める', () => {
  assert.equal(projectFolderName('D:\\work\\my-app'), 'D--work-my-app')
  assert.equal(projectFolderName('/home/me/my app/'), '-home-me-my-app')
  // 区切りや .. は残らない（projects の外を指せない）
  assert.equal(projectFolderName('..\\..\\secret'), '------secret')
})

test('発言と、発言ごとの最後の返事だけを取り出す', () => {
  const raw =
    user('2026-11-23T01:00:00Z', 'テストを直して') +
    claude('2026-11-23T01:00:05Z', [{ type: 'text', text: '調べます。' }, { type: 'tool_use', name: 'Bash', input: {} }]) +
    user('2026-11-23T01:00:06Z', [{ type: 'tool_result', content: '秘密の出力' }]) +
    claude('2026-11-23T01:00:10Z', [{ type: 'text', text: 'サブエージェントの文' }], { isSidechain: true }) +
    claude('2026-11-23T01:00:20Z', [{ type: 'text', text: '直しました。テストは通っています。' }]) +
    user('2026-11-23T01:01:00Z', '<command-name>/reload-plugins</command-name>') +
    user('2026-11-23T01:02:00Z', '要約です', { isCompactSummary: true }) +
    '壊れた行\n' +
    user('2026-11-23T01:03:00Z', [{ type: 'text', text: '<system-reminder>内部メモ</system-reminder>次はコミットして' }]) +
    claude('2026-11-23T01:03:30Z', [{ type: 'text', text: 'コミットしました。' }])
  assert.deepEqual(extractTurns(raw), [
    { ts: '2026-11-23T01:00:00Z', who: 'user', text: 'テストを直して' },
    { ts: '2026-11-23T01:00:20Z', who: 'claude', text: '直しました。テストは通っています。' },
    { ts: '2026-11-23T01:03:00Z', who: 'user', text: '次はコミットして' },
    { ts: '2026-11-23T01:03:30Z', who: 'claude', text: 'コミットしました。' },
  ])
})

test('すべてのプロジェクトの最近の記録を集める。除外したフォルダは読まない', async () => {
  const config = await mkdtemp(join(tmpdir(), 'aicarnation-sessions-'))
  try {
    const now = new Date('2026-11-23T03:00:00Z')
    const app = join(config, 'projects', projectFolderName('D:\\work\\app'))
    const secret = join(config, 'projects', projectFolderName('D:\\work\\private'))
    const nested = join(config, 'projects', projectFolderName('D:\\work\\private\\sub'))
    for (const dir of [app, secret, nested]) await mkdir(dir, { recursive: true })
    const inApp = { cwd: 'D:\\work\\app' }
    await writeFile(join(app, 'a.jsonl'), user('2026-11-22T10:00:00Z', '検索を速くしたい', inApp) + claude('2026-11-22T10:05:00Z', [{ type: 'text', text: '索引を足す案で止まっています。' }], inApp))
    await writeFile(join(app, 'old.jsonl'), user('2026-11-01T10:00:00Z', '古い話', inApp))
    await utimes(join(app, 'old.jsonl'), new Date('2026-11-01T10:00:00Z'), new Date('2026-11-01T10:00:00Z'))
    await writeFile(join(app, 'memo.txt'), '記録ではない')
    await writeFile(join(secret, 'b.jsonl'), user('2026-11-22T11:00:00Z', '別のプロジェクトの話', { cwd: 'D:\\work\\private' }))
    await writeFile(join(nested, 'c.jsonl'), user('2026-11-22T12:00:00Z', 'その下のフォルダの話', { cwd: 'D:\\work\\private\\sub' }))

    // フォルダを指定しなくても、すべてのプロジェクトの最近の記録を、時刻の順に見渡す（古い記録・記録でないファイルは入らない）
    const everything = await collectSessionTurns([], {}, now, config)
    assert.deepEqual(
      everything.map((t) => [t.project, t.who, t.text]),
      [
        ['app', 'user', '検索を速くしたい'],
        ['app', 'claude', '索引を足す案で止まっています。'],
        ['private', 'user', '別のプロジェクトの話'],
        ['sub', 'user', 'その下のフォルダの話'],
      ],
    )
    assert.equal(everything[0].ts, '2026-11-22T19:00:00+09:00')

    // 除外したフォルダと、その下のフォルダの記録は読まない
    const turns = await collectSessionTurns(['D:\\work\\private'], {}, now, config)
    assert.deepEqual(
      turns.map((t) => t.project),
      ['app', 'app'],
    )
    // 新しく更新されたファイルから数える。行数の上限は新しいものを残す
    assert.equal((await collectSessionTurns([], { maxLines: 1 }, now, config))[0].text, 'その下のフォルダの話')
    assert.equal((await collectSessionTurns([], { maxFiles: 1 }, now, config)).length >= 1, true)
    // 終わりの一部だけを読む（切れた最初の行は捨てる）
    assert.deepEqual((await collectSessionTurns(['D:\\work\\private'], { tailBytes: 250 }, now, config)).map((t) => t.who), ['claude'])
    // projects が無ければ空
    assert.deepEqual(await collectSessionTurns([], {}, now, join(config, 'none')), [])

    // 材料に入る（上限つき）。オフなら空
    const data = join(config, 'data')
    const m = await collectMaterials(data, { sessionsEnabled: true, sessionExcludeDirs: ['D:\\work\\private'], claudeConfigDir: config }, now)
    assert.equal(m.sessions, '[11/22 19:00 app ユーザー] 検索を速くしたい\n[11/22 19:05 app Claude] 索引を足す案で止まっています。')
    assert.equal(m.sessionLines, 2)
    assert.equal((await collectMaterials(data, { claudeConfigDir: config }, now)).sessions, '')
    assert.equal((await collectMaterials(data, { sessionsEnabled: true, sessionExcludeDirs: ['D:\\work\\private'], claudeConfigDir: config, sessionMaxChars: 50 }, now)).sessionLines, 1)
  } finally {
    await rm(config, { recursive: true, force: true })
  }
})

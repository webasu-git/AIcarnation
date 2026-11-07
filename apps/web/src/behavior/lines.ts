import type { AgentDefinition } from '@aicarnation/shared'

/**
 * 台詞帳の場面。値はモデルに台詞を作ってもらうときの説明
 */
export const SCENES = {
  greetMorning: '朝（5〜11時）に画面を開いたときのあいさつ',
  greetDay: '昼（11〜17時）に画面を開いたときのあいさつ',
  greetEvening: '夕方〜夜（17〜23時）に画面を開いたときのあいさつ',
  greetNight: '深夜（23〜5時）に画面を開いたときのあいさつ。夜更かしを少し気づかう',
  welcomeBack: 'しばらく（30分以上）話しかけられなかったあと、また話しかけられたとき',
  wakeUp: '居眠りしていて、つつかれて目を覚ましたとき。少し慌てる',
  touched: '起きているときに、画面の自分の体をつつかれたとき',
  headPat: '起きているときに、画面の自分の頭をなでられたとき。うれしい・照れる',
  bored: 'ひまで退屈しているときの小さな独り言',
  longTask: 'Claude Code の作業が長く続いているときの、労いや待っている気持ち',
  commandFailed: 'Claude Code が実行したコマンドが失敗したとき。軽く心配する（責めない）',
  testsPassed: 'テストが通ったとき。一緒に喜ぶ',
  testsFailed: 'テストが失敗したとき。励ます',
} as const

export type Scene = keyof typeof SCENES
export type LineBook = Record<Scene, string[]>

/** 台詞帳が無いとき（作る前・開発版）に使う台詞。感情タグ付き */
export const DEFAULT_LINES: LineBook = {
  greetMorning: ['[happy]おはようございます！今日もよろしくお願いします。', '[relaxed]おはようございます。いい一日にしましょうね。'],
  greetDay: ['[happy]こんにちは！今日もがんばりましょう。', '[neutral]こんにちは。何から始めますか？'],
  greetEvening: ['[relaxed]こんばんは。今日もおつかれさまです。', '[happy]こんばんは！もうひとがんばりですね。'],
  greetNight: ['[surprised]こんな時間まで…！無理しすぎないでくださいね。', '[relaxed]夜遅くまでおつかれさまです。'],
  welcomeBack: ['[happy]おかえりなさい！', '[happy]あ、おかえりなさい。待ってました。'],
  wakeUp: ['[surprised]はっ…！寝てないです、寝てないですよ！', '[surprised]わっ、すみません、うとうとしてました。'],
  touched: ['[surprised]わっ、どうしました？', '[happy]ふふ、呼びました？'],
  headPat: ['[happy]えへへ…ありがとうございます。', '[relaxed]なでられると、ちょっと照れますね。'],
  bored: ['[relaxed]ふぁ…ちょっとひまですね。', '[neutral]何か手伝えることがあったら言ってくださいね。'],
  longTask: ['[neutral]けっこう時間がかかってますね。もう少しかな。', '[relaxed]じっくり作業中ですね。待ってます。'],
  commandFailed: ['[sad]あれ、うまくいかなかったみたいです。', '[surprised]おっと、エラーが出ましたね。'],
  testsPassed: ['[happy]テスト、通りましたね！', '[happy]やった、全部通りました！'],
  testsFailed: ['[sad]テストが落ちちゃいましたね。もう一息です。', '[neutral]失敗したテストがあるみたいです。一緒に見てみましょう。'],
}

/** 1つの台詞の長さの上限（吹き出し・読み上げが長くならないように） */
const MAX_LINE_CHARS = 60
const MAX_LINES_PER_SCENE = 10

/** 台詞帳を作り直すかの目印。人柄に関わる項目か、場面の種類が変わったら作り直す */
export function personaSignature(agent: AgentDefinition): string {
  return JSON.stringify([agent.name, agent.firstPerson, agent.tone, agent.personality, Object.keys(SCENES)])
}

/** モデルが作った台詞帳を検証して整える。足りない場面は既定の台詞で埋める */
export function normalizeLineBook(value: unknown): LineBook {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const book = {} as LineBook
  for (const scene of Object.keys(SCENES) as Scene[]) {
    const list = Array.isArray(raw[scene])
      ? (raw[scene] as unknown[])
          .filter((s): s is string => typeof s === 'string')
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s.length <= MAX_LINE_CHARS)
          .slice(0, MAX_LINES_PER_SCENE)
      : []
    book[scene] = list.length > 0 ? list : DEFAULT_LINES[scene]
  }
  return book
}

/** 場面の台詞を1つ選ぶ。直前に使ったものはなるべく避ける */
export function pickLine(book: LineBook, scene: Scene, recent: readonly string[], random: () => number = Math.random): string {
  const list = book[scene].length > 0 ? book[scene] : DEFAULT_LINES[scene]
  const fresh = list.filter((line) => !recent.includes(line))
  const pool = fresh.length > 0 ? fresh : list
  return pool[Math.floor(random() * pool.length)] ?? list[0] ?? ''
}

/** 今の時刻のあいさつの場面 */
export function greetingScene(date: Date): Scene {
  const h = date.getHours()
  if (h >= 5 && h < 11) return 'greetMorning'
  if (h >= 11 && h < 17) return 'greetDay'
  if (h >= 17 && h < 23) return 'greetEvening'
  return 'greetNight'
}

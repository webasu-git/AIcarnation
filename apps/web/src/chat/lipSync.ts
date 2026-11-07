import type { Viseme } from '../vrm/expression'

/** 口の動きの1単位。viseme が null のときは口を閉じる */
export interface MouthStep {
  viseme: Viseme | null
  /** 0〜1 の開き具合 */
  weight: number
  /** この口形を保つ時間（ms） */
  duration: number
}

/** 1モーラ（拍）の長さ。日本語の自然な話速（毎秒7〜8拍）に合わせる */
export const MORA_MS = 120
const COMMA_PAUSE_MS = 260
const PERIOD_PAUSE_MS = 380

const VOWEL_ROWS: Record<Viseme, string> = {
  aa: 'あかさたなはまやらわがざだばぱぁゃゎ',
  ih: 'いきしちにひみりぎじぢびぴぃ',
  ou: 'うくすつぬふむゆるぐずづぶぷぅゅゔ',
  ee: 'えけせてねへめれげぜでべぺぇ',
  oh: 'おこそとのほもよろをごぞどぼぽぉょ',
}

const KANA_VOWEL = new Map<string, Viseme>()
for (const [viseme, row] of Object.entries(VOWEL_ROWS) as [Viseme, string][]) {
  for (const ch of row) {
    KANA_VOWEL.set(ch, viseme)
    // カタカナはひらがなの 0x60 後ろにある
    KANA_VOWEL.set(String.fromCharCode(ch.charCodeAt(0) + 0x60), viseme)
  }
}

const SMALL_KANA = new Set('ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ')
const LATIN_VOWEL: Record<string, Viseme> = { a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh' }

/** 母音ごとの開き具合。「い」「う」は形の変化が大きいので控えめにする */
const VISEME_SCALE: Record<Viseme, number> = { aa: 1, oh: 0.9, ee: 0.8, ih: 0.7, ou: 0.7 }

/**
 * 音声エンジンの母音を口形にする。大文字は無声化した母音（小さめに開く）、
 * N は撥音（ほぼ閉じる）、cl は促音・pau は息継ぎ（閉じる）
 */
export function visemeForVowel(vowel: string): { viseme: Viseme; scale: number } | null {
  if (vowel === 'N') return { viseme: 'ou', scale: 0.2 }
  const viseme = LATIN_VOWEL[vowel.toLowerCase()]
  if (!viseme) return null
  return { viseme, scale: VISEME_SCALE[viseme] * (vowel === vowel.toUpperCase() ? 0.5 : 1) }
}

/** 漢字は読みが分からないので、日本語の母音の出現頻度に近い重みで選ぶ */
const KANJI_VOWELS: [Viseme, number][] = [
  ['aa', 0.26],
  ['ih', 0.22],
  ['ou', 0.2],
  ['oh', 0.2],
  ['ee', 0.12],
]

function pickVowel(rand: () => number): Viseme {
  let r = rand()
  for (const [v, p] of KANJI_VOWELS) {
    if ((r -= p) <= 0) return v
  }
  return 'aa'
}

function open(viseme: Viseme, rand: () => number, duration = MORA_MS): MouthStep {
  // 大きく開けすぎると大げさに見えるので、「あ」でも半分ほどまでにする
  return { viseme, weight: (0.35 + rand() * 0.2) * VISEME_SCALE[viseme], duration }
}

const close = (duration: number): MouthStep => ({ viseme: null, weight: 0, duration })

/**
 * 1文字ぶんの口の動きを決める。prev は直前の母音（小書きかな・長音のため）
 */
export function planChar(ch: string, prev: Viseme | null, rand: () => number = Math.random): MouthStep[] {
  if (/[、，,]/.test(ch)) return [close(COMMA_PAUSE_MS)]
  if (/[。．.！？!?…]/.test(ch)) return [close(PERIOD_PAUSE_MS)]
  if (/[\s「」『』（）()【】・〜~"'”“]/.test(ch)) return []

  // 小書きかなは直前の拍と一体なので、母音だけ短く切り替える（「きゃ」→ い→あ）
  const vowel = KANA_VOWEL.get(ch)
  if (SMALL_KANA.has(ch) && vowel) return [open(vowel, rand, MORA_MS * 0.5)]
  if (vowel) return [open(vowel, rand)]
  // 促音は一瞬口を閉じる
  if (ch === 'っ' || ch === 'ッ') return [close(MORA_MS * 0.8)]
  // 撥音は口をほぼ閉じたまま1拍
  if (ch === 'ん' || ch === 'ン') return [{ viseme: 'ou', weight: 0.12, duration: MORA_MS }]
  // 長音は直前の母音を伸ばす
  if (ch === 'ー') return [open(prev ?? 'aa', rand)]
  // 漢字は2拍ぶん
  if (/\p{Script=Han}/u.test(ch)) return [open(pickVowel(rand), rand), open(pickVowel(rand), rand)]
  const latin = LATIN_VOWEL[ch.toLowerCase()]
  if (latin) return [open(latin, rand)]
  if (/[a-z0-9]/i.test(ch)) return [open(pickVowel(rand), rand, MORA_MS * 0.7)]
  return [open(pickVowel(rand), rand)]
}

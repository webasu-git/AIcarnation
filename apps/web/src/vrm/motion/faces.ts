import type { Emotion } from '@aicarnation/shared'
import type { MouthShape } from '../fallbackExpressions'

/**
 * 動きのファイルに合わせた顔（表情・目の閉じ・口の開き）。
 * 動きのファイル（Mixamo など）には顔の動きが入っていないので、ファイル名から動きの種類を見分けて、
 * それらしい顔を重ねる。あくびなら途中で目を閉じて口を開け、拍手なら笑顔、首を振るなら困り顔、など。
 * 返事を話している間は、返事の感情タグの表情が優先する（expression.ts）
 */

/** 動きの途中の、一時的な顔の変化（動きの長さに対する割合で、いつからいつまでか） */
export interface FaceCue {
  from: number
  to: number
  /** 目の閉じ（0〜1） */
  eyeClose?: number
  /** 目を閉じて笑う形（0〜1） */
  eyeSmile?: number
  /** 口の開き（0〜1） */
  mouthOpen?: number
  /** この間だけ、口をこの形にする（強さは mouthAmount） */
  mouth?: MouthShape
  mouthAmount?: number
}

export interface MotionFace {
  /** 動きのあいだの表情（無ければ表情は変えない） */
  emotion?: Exclude<Emotion, 'neutral'>
  /** 表情の強さ（0〜1） */
  strength: number
  /** ずっと少し目を細める量（手元を見る・考え込むなど） */
  eyeClose?: number
  /** ずっと目を閉じて笑う量（笑う動き） */
  eyeSmile?: number
  /** 動きのあいだの口の形と強さ（0〜1）。話していないときだけ出す */
  mouth?: MouthShape
  mouthAmount?: number
  cues?: FaceCue[]
}

/** 見分け方（上から順に、最初に当てはまったもの）。名前は小文字にし、空白・記号を除いてから照らし合わせる */
const RULES: { test: RegExp; face: MotionFace }[] = [
  // あくび：途中で目を閉じて大きく口を開ける。その前後は口を閉じて気だるげ
  {
    test: /yawn|あくび/,
    face: { emotion: 'relaxed', strength: 0.3, mouth: 'flat', mouthAmount: 0.4, cues: [{ from: 0.18, to: 0.62, eyeClose: 0.9, mouthOpen: 0.85 }] },
  },
  // 伸び・首回し：気持ちよさそうに目を閉じ、口元はゆるむ
  { test: /stretch|伸び/, face: { emotion: 'relaxed', strength: 0.5, mouth: 'smile', mouthAmount: 0.5, cues: [{ from: 0.2, to: 0.75, eyeSmile: 0.8 }] } },
  // ため息：目を伏せて、すぼめた口から息を吐く
  { test: /sigh|ため息/, face: { emotion: 'relaxed', strength: 0.4, mouth: 'flat', mouthAmount: 0.4, cues: [{ from: 0.25, to: 0.7, eyeClose: 0.5, mouth: 'pout', mouthAmount: 0.8 }] } },
  // 首を横に振る・がっかり：困り顔で、口はへの字
  { test: /headshake|shakinghead|disappoint|annoyed|sadidle|crying|がっかり/, face: { emotion: 'sad', strength: 0.45, mouth: 'frown', mouthAmount: 0.7 } },
  // 投げキッス：笑顔で、キスのところは目を閉じて口をとがらせる
  {
    test: /kiss|キス/,
    face: { emotion: 'happy', strength: 0.7, mouth: 'smile', mouthAmount: 0.7, cues: [{ from: 0.35, to: 0.6, eyeSmile: 0.9, mouth: 'pucker', mouthAmount: 1 }] },
  },
  // 喜ぶ・拍手・ガッツポーズ・ピース：口を開けて笑う
  // 喜ぶ・拍手・ガッツポーズ・ピースは、いちばん盛り上がるところで目を閉じて笑う
  {
    test: /clap|cheer|excited|victory|fistpump|celebrat|joy|peace|ピース|喜/,
    face: { emotion: 'happy', strength: 0.75, mouth: 'grin', mouthAmount: 0.8, cues: [{ from: 0.2, to: 0.8, eyeSmile: 0.85 }] },
  },
  // 手を振る・あいさつ・おじぎ：にこやかに、口を少し開けて笑う
  // 手を振る・あいさつ・おじぎは、真ん中あたりで一度にっこり目を細める
  {
    test: /wav(e|ing)|greet|hello|bow|salute|あいさつ|挨拶|おじぎ/,
    face: { emotion: 'happy', strength: 0.6, mouth: 'grin', mouthAmount: 0.5, cues: [{ from: 0.35, to: 0.7, eyeSmile: 0.6 }] },
  },
  // 楽しそうな待機・身ぶり：ほほえむ
  { test: /laugh|funny/, face: { emotion: 'happy', strength: 0.6, mouth: 'grin', mouthAmount: 0.7, cues: [{ from: 0.15, to: 0.85, eyeSmile: 0.8 }] } },
  { test: /happy/, face: { emotion: 'happy', strength: 0.45, mouth: 'smile', mouthAmount: 0.8 } },
  // うなずく・同意：軽くほほえむ
  { test: /headnod|nodding|agree|acknowledg|うなず/, face: { emotion: 'happy', strength: 0.3, mouth: 'smile', mouthAmount: 0.6 } },
  // 内緒話：いたずらっぽく ω の口
  { test: /secret|内緒/, face: { emotion: 'happy', strength: 0.4, mouth: 'cat', mouthAmount: 0.8 } },
  // きょろきょろ・振り返る：少し驚いて「お」の口
  { test: /nervous|lookover|lookbehind|lookingbehind|surprise|驚/, face: { emotion: 'surprised', strength: 0.35, mouth: 'pout', mouthAmount: 0.6 } },
  { test: /lookaround|lookingaround|見回/, face: { emotion: 'surprised', strength: 0.2, mouth: 'pout', mouthAmount: 0.4 } },
  // 退屈・肩をすくめる・まあいいか：気だるげに目を細め、口はきゅっと閉じる
  { test: /bored|shrug|whatever|dismiss|退屈/, face: { emotion: 'relaxed', strength: 0.45, eyeClose: 0.15, mouth: 'flat', mouthAmount: 0.7 } },
  // 考える・探す・遠くを見る：目を少し細め、口をすぼめて「うーん」
  { test: /think|ponder|wonder|thoughtful|looking|search|考/, face: { emotion: 'relaxed', strength: 0.2, eyeClose: 0.1, mouth: 'pout', mouthAmount: 0.6 } },
  // 手元の作業：手元を見るので目を少し伏せる（口はふだんのまま閉じておく。口の形を足すと、モデルによって半開きに見える）
  { test: /count|tablet|texting|typing|phone|code|writing|作業/, face: { strength: 0, eyeClose: 0.12 } },
]

/** 名前を照らし合わせやすい形にする（小文字・空白と記号を除く） */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.(fbx|vrma)$/, '')
    .replace(/[\s_\-()（）[\]【】.・]/g, '')
}

/** 動きのファイル名から、合わせる顔を決める。当てはまらなければ null（顔は変えない） */
export function faceForMotion(name: string): MotionFace | null {
  const key = normalize(name)
  return RULES.find((rule) => rule.test.test(key))?.face ?? null
}

/** 両端でなめらかに 0→1→0 になる山（区間 from〜to の中の位置 t に対して） */
function bump(t: number, from: number, to: number): number {
  if (t <= from || t >= to) return 0
  const u = (t - from) / (to - from)
  // 入りと抜けを区間の 3 割ずつにして、真ん中は保つ
  const edge = 0.3
  const s = u < edge ? u / edge : u > 1 - edge ? (1 - u) / edge : 1
  return s * s * (3 - 2 * s)
}

/** 動きの位置 t（0〜1）での顔 */
export interface FaceNow {
  emotion?: Exclude<Emotion, 'neutral'>
  strength: number
  eyeClose: number
  eyeSmile: number
  mouthOpen: number
  /** 口の形と強さ。途中の変化（cue）が出ている間は、もとの形から移り変わる */
  mouths: Partial<Record<MouthShape, number>>
}

export function evaluateFace(face: MotionFace, t: number): FaceNow {
  let eyeClose = face.eyeClose ?? 0
  let eyeSmile = face.eyeSmile ?? 0
  let mouthOpen = 0
  const mouths: Partial<Record<MouthShape, number>> = {}
  let cueMouth = 0
  for (const cue of face.cues ?? []) {
    const b = bump(t, cue.from, cue.to)
    eyeClose = Math.max(eyeClose, (cue.eyeClose ?? 0) * b)
    eyeSmile = Math.max(eyeSmile, (cue.eyeSmile ?? 0) * b)
    mouthOpen = Math.max(mouthOpen, (cue.mouthOpen ?? 0) * b)
    if (cue.mouth && b > 0) {
      mouths[cue.mouth] = Math.max(mouths[cue.mouth] ?? 0, (cue.mouthAmount ?? 1) * b)
      cueMouth = Math.max(cueMouth, b)
    }
  }
  // 途中で口を大きく開ける・別の形にする間は、もとの口の形を弱める
  if (face.mouth) {
    const keep = 1 - Math.max(cueMouth, mouthOpen > 0 ? Math.min(1, mouthOpen / 0.5) : 0)
    mouths[face.mouth] = Math.max(mouths[face.mouth] ?? 0, (face.mouthAmount ?? 1) * keep)
  }
  return { emotion: face.emotion, strength: face.strength, eyeClose, eyeSmile, mouthOpen, mouths }
}

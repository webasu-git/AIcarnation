import * as THREE from 'three'
import { VRMExpression, VRMExpressionMorphTargetBind, type VRM } from '@pixiv/three-vrm'
import { DEFAULT_EMOTION, EMOTIONS, type Emotion } from '@aicarnation/shared'
import { EYES_SMILE, MOUTH_SHAPES, mouthExpressionName, type MouthShape } from './fallbackExpressions'

/** 口形（VRM の標準表情 aa/ih/ou/ee/oh ＝ あ/い/う/え/お） */
export const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const
export type Viseme = (typeof VISEMES)[number]

/** 表情の切り替えにかける時間の目安（秒） */
const EMOTION_SMOOTHING = 0.15
/** 口を開くとき・閉じるときの追従の速さ（秒）。閉じる方を少し遅くすると自然に見える */
const MOUTH_ATTACK = 0.05
const MOUTH_RELEASE = 0.08
/**
 * 感情表情の強さ。モデルによっては笑顔などの表情自体に口の形が含まれており、
 * 最大にすると口形と重なって崩れるので控えめにする
 */
const EMOTION_WEIGHT = 0.8
/**
 * 目元だけの表情を作れないモデルで、話している間に残す感情表情の割合（EMOTION_WEIGHT に対する）。
 * 笑顔・驚きなどの表情には口の形（開いた笑い口など）も含まれていて、口形と重ねると口が二重になるため
 */
const EMOTION_WHILE_SPEAKING = 0.3
/** 話しているかどうかの切り替えにかける時間（秒）。拍の合間や息継ぎで表情がちらつかないよう、ゆっくりにする */
const SPEAKING_SMOOTHING = 0.25
/** 話し終えてから表情を戻し始めるまで（秒）。文の合間で表情が強まったり弱まったりしないようにする */
const SPEAKING_HOLD = 0.6

/**
 * 話している間に使う「目元・眉だけ」の表情の材料（モーフ名の末尾と強さ）。
 * 感情の標準表情は顔全体（口を含む）を1つのモーフで動かすモデルが多いので、
 * 目元・眉のモーフを別に持つモデルでは、話している間はこちらに切り替えて口は口形だけにする。
 * VRoid 系（Fcl_EYE_* / Fcl_BRW_*）と、ほかのモデルの eye_* の名前に対応する
 */
const EYE_MORPHS: Partial<Record<Emotion, [string, number][]>> = {
  happy: [['Fcl_EYE_Joy', 1], ['Fcl_BRW_Joy', 1], ['eye_smile', 1]],
  relaxed: [['Fcl_EYE_Joy', 0.5], ['Fcl_BRW_Fun', 1], ['eye_smile', 0.6]],
  angry: [['Fcl_EYE_Angry', 1], ['Fcl_BRW_Angry', 1], ['eye_angry', 1], ['eye_brow_down', 1]],
  sad: [['Fcl_EYE_Sorrow', 1], ['Fcl_BRW_Sorrow', 1], ['eye_brow_up', 0.7]],
  surprised: [['Fcl_EYE_Surprised', 1], ['Fcl_BRW_Surprised', 1], ['eye_brow_up', 1], ['eye_small', 0.6]],
}
/** 目を細める表情。まばたきと重なると閉じすぎるので、この表情の間はまばたきを抑える */
const BLINK_BLOCKING: Emotion[] = ['happy', 'relaxed']
/** 返事の感情が出ていて話していない間の口の形（組み立てた表情は目元・眉だけなので、口はこちらで足す） */
const EMOTION_MOUTH: Partial<Record<Emotion, [MouthShape, number]>> = {
  happy: ['smile', 1],
  relaxed: ['smile', 0.8],
  sad: ['frown', 1],
  angry: ['frown', 1],
  surprised: ['pout', 0.5],
}
/**
 * 感情が出ていて話していない間に、口を少し開ける量（口形で開く）。感情が口元でも見えるようにする。
 * 喜びは開いた笑い口、驚きは「お」の口、怒りは歯を見せる「い」の口、悲しみは少しだけ開く
 */
const EMOTION_OPEN: Partial<Record<Emotion, [Viseme, number]>> = {
  happy: ['aa', 0.3],
  surprised: ['oh', 0.55],
  angry: ['ih', 0.3],
  sad: ['ou', 0.15],
}
/** 口の形のうち、感情そのものの口（モデルの元からある表情が口まで動かすなら、重ねない） */
const EMOTION_SHAPES: MouthShape[] = ['smile', 'grin', 'frown', 'cat']
/** 口の形の切り替えにかける時間（秒） */
const MOUTH_SHAPE_SMOOTHING = 0.2

function eyesName(emotion: Emotion): string {
  return `${emotion}-eyes`
}

/**
 * 目元・眉だけの表情をモデルに足す。材料のモーフが1つも無ければ足さない。
 * 足した表情の名前（感情ごと）を返す
 */
function registerEyeExpressions(vrm: VRM): Map<Emotion, string> {
  const added = new Map<Emotion, string>()
  const manager = vrm.expressionManager
  if (!manager) return added
  const meshes: THREE.Mesh[] = []
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh && mesh.morphTargetDictionary) meshes.push(mesh)
  })
  for (const [emotion, morphs] of Object.entries(EYE_MORPHS) as [Emotion, [string, number][]][]) {
    const expression = new VRMExpression(eyesName(emotion))
    let binds = 0
    for (const mesh of meshes) {
      for (const [key, index] of Object.entries(mesh.morphTargetDictionary ?? {})) {
        // VRoid の名前は「Face.M_F00_000_00_Fcl_EYE_Joy」のように前に付くものがあるので、末尾で見る
        const found = morphs.find(([name]) => key === name || key.endsWith(`_${name}`) || key.endsWith(`.${name}`))
        if (!found) continue
        expression.addBind(new VRMExpressionMorphTargetBind({ primitives: [mesh], index, weight: found[1] }))
        binds++
      }
    }
    if (binds === 0) continue
    if (BLINK_BLOCKING.includes(emotion)) expression.overrideBlink = 'blend'
    manager.registerExpression(expression)
    added.set(emotion, expression.expressionName)
  }
  return added
}

/**
 * 感情表情と口形を管理する。
 * モデルに該当表情がない場合は neutral にフォールバックする。
 *
 * 話している間は、感情を「目元・眉だけ」の表情で出し（モデルが対応していれば）、口は口形だけにする。
 * 対応していないモデルでは、感情表情を弱めて口形を主役にする
 */
export class ExpressionController {
  private readonly weights = new Map<string, number>()
  private emotion: Emotion = DEFAULT_EMOTION
  private viseme: Viseme | null = null
  private mouthWeight = 0
  /** 話している度合い（0〜1）。口形が出ている間は 1 に近づく */
  private speaking = 0
  /** 最後に口形が出てからの時間（秒） */
  private sinceMouth = Infinity
  /** 感情ごとの「目元・眉だけ」の表情の名前 */
  private readonly eyes: Map<Emotion, string>

  /** モデルが元から持っている感情の表情（顔全体なので口も動く）。組み立てた表情は目元・眉だけ */
  private readonly nativeEmotions: Set<Emotion>

  /** built は registerFallbackExpressions が組み立てた表情の名前 */
  constructor(
    private readonly vrm: VRM,
    built: string[] = [],
  ) {
    this.eyes = registerEyeExpressions(vrm)
    this.nativeEmotions = new Set(EMOTIONS.filter((e) => e !== 'neutral' && this.hasExpression(e) && !built.includes(e)))
  }

  hasExpression(name: string): boolean {
    return this.vrm.expressionManager?.getExpression(name) != null
  }

  setEmotion(emotion: Emotion): void {
    this.emotion = this.hasExpression(emotion) ? emotion : DEFAULT_EMOTION
  }

  get currentEmotion(): Emotion {
    return this.emotion
  }

  /** 口形を指定する。値はすぐには反映せず、update でなめらかに近づける */
  setMouth(viseme: Viseme | null, weight: number): void {
    this.viseme = viseme
    this.mouthWeight = Math.min(1, Math.max(0, weight))
  }

  /** 動きのファイルに合わせる表情と強さ（返事の感情が出ている間・話している間は使わない） */
  private motionEmotion: Emotion | null = null
  private motionStrength = 0
  /** 動きのファイルに合わせる口の形と強さ（話していないときだけ） */
  private motionMouths: Partial<Record<MouthShape, number>> = {}
  /** 動きのファイルに合わせて、目を閉じて笑う量（笑う動きのときだけ） */
  private motionEyeSmile = 0
  setMotionFace(emotion: Emotion | null, strength: number, mouths: Partial<Record<MouthShape, number>> = {}, eyeSmile = 0): void {
    this.motionEmotion = emotion && this.hasExpression(emotion) ? emotion : null
    this.motionStrength = Math.min(1, Math.max(0, strength))
    this.motionMouths = mouths
    this.motionEyeSmile = Math.min(1, Math.max(0, eyeSmile))
  }

  /** あくびなど、話していないときに口を開ける量（口パクがあればそちらを優先する） */
  private idleMouth = 0
  setIdleMouth(weight: number): void {
    this.idleMouth = Math.min(1, Math.max(0, weight))
  }

  update(delta: number): void {
    const manager = this.vrm.expressionManager
    if (!manager) return

    const approach = (name: string, target: number, tau: number) => {
      if (!this.hasExpression(name)) return
      const current = this.weights.get(name) ?? 0
      const next = current + (target - current) * (1 - Math.exp(-delta / tau))
      this.weights.set(name, next)
      manager.setValue(name, next)
    }

    // 口形が出ている間（と、その少し後まで）は話しているとみなす
    this.sinceMouth = this.viseme && this.mouthWeight > 0 ? 0 : this.sinceMouth + delta
    const speakingTarget = this.sinceMouth < SPEAKING_HOLD ? 1 : 0
    this.speaking += (speakingTarget - this.speaking) * (1 - Math.exp(-delta / SPEAKING_SMOOTHING))

    // 返事の感情が出ていないときだけ、動きのファイルに合わせた表情を出す（話している間は弱める）
    const motionWeight =
      this.emotion === 'neutral' && this.motionEmotion ? EMOTION_WEIGHT * this.motionStrength * (1 - this.speaking) : 0

    for (const e of EMOTIONS) {
      if (e === 'neutral') continue
      const active = e === this.emotion
      const fromMotion = e === this.motionEmotion ? motionWeight : 0
      const eyes = this.eyes.get(e)
      if (eyes) {
        // 話している分だけ、顔全体の表情から目元・眉だけの表情へ移す
        approach(e, active ? EMOTION_WEIGHT * (1 - this.speaking) : fromMotion, EMOTION_SMOOTHING)
        approach(eyes, active ? EMOTION_WEIGHT * this.speaking : 0, EMOTION_SMOOTHING)
      } else {
        const weight = EMOTION_WEIGHT * (1 - this.speaking * (1 - EMOTION_WHILE_SPEAKING))
        approach(e, active ? weight : fromMotion, EMOTION_SMOOTHING)
      }
    }

    // 話していないときの口の形：返事の感情が出ていればその感情の口、出ていなければ動きのファイルに合わせた口。
    // 話している間・あくびで口を開けている間は弱める
    const quiet = (1 - this.speaking) * (1 - Math.min(1, this.idleMouth * 2))
    const mouthTargets: Partial<Record<MouthShape, number>> = {}
    if (this.emotion !== 'neutral') {
      const m = EMOTION_MOUTH[this.emotion]
      if (m && !this.nativeEmotions.has(this.emotion)) mouthTargets[m[0]] = m[1]
    } else {
      const native = this.motionEmotion !== null && this.nativeEmotions.has(this.motionEmotion)
      for (const [shape, amount] of Object.entries(this.motionMouths) as [MouthShape, number][]) {
        if (native && EMOTION_SHAPES.includes(shape)) continue
        mouthTargets[shape] = amount
      }
    }
    for (const shape of MOUTH_SHAPES) {
      approach(mouthExpressionName(shape), (mouthTargets[shape] ?? 0) * quiet, MOUTH_SHAPE_SMOOTHING)
    }
    // 目を閉じて笑う形は、笑う動きの盛り上がるところだけ（返事の感情が出ている間・話している間は出さない）
    approach(EYES_SMILE, this.emotion === 'neutral' ? this.motionEyeSmile * (1 - this.speaking) : 0, MOUTH_SHAPE_SMOOTHING)

    const open = this.emotion !== 'neutral' ? EMOTION_OPEN[this.emotion] : undefined
    for (const v of VISEMES) {
      let target = v === this.viseme ? this.mouthWeight : 0
      if (!this.viseme && v === 'aa') target = this.idleMouth
      if (!this.viseme && open && open[0] === v) target = Math.max(target, open[1] * quiet)
      const current = this.weights.get(v) ?? 0
      approach(v, target, target > current ? MOUTH_ATTACK : MOUTH_RELEASE)
    }
  }
}

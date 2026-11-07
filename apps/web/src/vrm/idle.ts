import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import { inspectRig, type RigInfo } from './rig'
import type { Emotion } from '@aicarnation/shared'
import { ARM_REST, BaseIdle } from './motion/base'
import { ExpressiveMotion, type SpeechCue } from './motion/expressive'
import { addRotation, type Pose, type Rotation } from './motion/pose'
import { PoseSpring } from './motion/spring'
import type { ClipDrive } from './motion/clips'
import type { FaceNow } from './motion/faces'
import type { MouthShape } from './fallbackExpressions'
import { softLimit } from './motion/inPlace'

const tmpEuler = new THREE.Euler()
const tmpTarget = new THREE.Quaternion()
const IDENTITY = new THREE.Quaternion()
const tmpGoal = new THREE.Vector3()
const tmpQuat = new THREE.Quaternion()
/** 腕と手（肩・上腕・前腕・手首・指）のボーン */
const ARM_BONE = /(Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)/
/** 動きのファイルで頭が横へ寄ってよい目安（基本の腰の高さに対する割合） */
const MAX_HEAD_SIDE = 0.1

const BLINK_INTERVAL_MIN = 3
const BLINK_INTERVAL_MAX = 6
const BLINK_DURATION = 0.15
/** ときどき2回続けてまばたきする確率 */
const DOUBLE_BLINK_CHANCE = 0.15
const GAZE_INTERVAL_MIN = 2
const GAZE_INTERVAL_MAX = 5
/** 視線がさまよう範囲（m）。カメラ位置を中心にする */
const GAZE_RANGE = 0.12
/** 姿勢を切り替えるときの追従の速さ（秒）。大きいほどゆっくり移る */
const POSTURE_SMOOTHING = 0.35
/** 居眠りに入る・目を覚ますときの、まぶたと姿勢の移り変わりの速さ（秒） */
const DOZE_SMOOTHING = 1.2
const NOD_DURATION = 0.55
const NOD_DEPTH = 0.12
/** マウスを目で追うのは、最後に動かしてからこの秒数まで */
const POINTER_GAZE_SECONDS = 3
/** マウスを追うとき、視線に合わせて体を向ける割合（ラジアン/m）と、その上限 */
const POINTER_HEAD_FOLLOW = 0.8
const POINTER_MAX_YAW = 0.5
const POINTER_MAX_PITCH = 0.25
/** マウスを追う向きの移り変わりの速さ（秒） */
const POINTER_SMOOTHING = 0.25
/** 向きたい角度のうち、腰から胸までが受け持つ割合（左右・上下）と、その遅れ（秒） */
const TORSO_YAW_SHARE = 0.4
const TORSO_PITCH_SHARE = 0.25
const TORSO_SMOOTHING = 0.6
/**
 * 腰回りを崩れにくくする：背骨（spine）の回転のうち、胸へ移す割合。
 * MMD から変換したモデルなどは、腰の飾りやコートの裾が背骨にぶら下がっていて、背骨を回すと飾りだけが回って脚とずれる。
 * 背骨の回転の多くを胸に受け持たせ、胸から上の向きは変えずに、背骨そのものはあまり回さない
 */
const STEADY_WAIST_SHARE = 0.75
/** 体のひねりのうち、腰が受け持つ割合（腰からまとめて回すと、腰に付いて動く服と腕がずれにくい） */
const HIPS_YAW_SHARE = 0.6

/**
 * アバターの今の様子。会話の進み具合に合わせて外から切り替える
 * - listening：話しかけられた直後
 * - thinking：返答を考えている（待っている）
 * - working：Claude Code がツールを使って作業している
 * - speaking：返答を話している
 */
export type MotionState = 'idle' | 'listening' | 'thinking' | 'working' | 'speaking'

/**
 * 会話していないとき（idle）の過ごし方
 * - awake：ふつうに待っている
 * - bored：退屈している（身ぶりが大きくなる）
 * - dozing：居眠りしている（目を閉じてうつむき、ゆっくり呼吸する）
 */
export type IdleMood = 'awake' | 'bored' | 'dozing'

/**
 * ひとりで過ごすときの身ぶり。1回きりで、終わると元の姿勢に戻る。
 * - 体：見回す・首かしげ・あくび・目覚め
 * - 表情つき：ほほえむ・リズムに乗る（表情を持つモデルだけ表情も変わる。無ければ頭と体の動きだけになる）
 * どのモデルでも崩れないよう、頭・視線・まぶた・口・表情と、ごくわずかな上半身の傾きだけで動かす（腕は使わない）。
 * 腕を使う動きや大きな動きは、利用者が動きのファイルで入れる
 */
export type Gesture = 'lookAround' | 'tilt' | 'yawn' | 'wake' | 'smile' | 'groove'

interface Posture {
  /** 頭の前後（+ で下を向く）・左右（+ でモデルの左を向く）・かしげ（+ でモデルの右に傾く）。ラジアン、VRM 1.0 の向き */
  headX: number
  headY: number
  headZ: number
  /** 上半身の前傾 */
  lean: number
  /** 視線の向き（カメラからのずれ。m） */
  gazeX: number
  gazeY: number
}

const POSTURES: Record<MotionState, Posture> = {
  idle: { headX: 0, headY: 0, headZ: 0, lean: 0, gazeX: 0, gazeY: 0 },
  // 少し前のめりで、首をかしげて聞く
  listening: { headX: 0.05, headY: 0, headZ: 0.09, lean: 0.04, gazeX: 0, gazeY: 0 },
  // 視線を斜め上にそらし、首をかしげて考える
  thinking: { headX: -0.1, headY: 0.16, headZ: -0.1, lean: -0.02, gazeX: -0.3, gazeY: 0.22 },
  // 少しうつむいて、手元を読んでいるように
  working: { headX: 0.15, headY: -0.06, headZ: 0.04, lean: 0.05, gazeX: 0.08, gazeY: -0.28 },
  speaking: { headX: 0, headY: 0, headZ: 0, lean: 0.02, gazeX: 0, gazeY: 0 },
}

/** 居眠りの姿勢：うつむいて、少し前に傾く */
const DOZE_POSTURE: Posture = { headX: 0.42, headY: 0.06, headZ: 0.14, lean: 0.08, gazeX: 0, gazeY: -0.3 }

/** 身ぶりがその瞬間に足す動き（すべて元の姿勢からのずれ） */
interface GestureOffset {
  headX: number
  headY: number
  headZ: number
  lean: number
  /** まぶたを閉じる量（0〜1） */
  eyeClose: number
  /** 口を開ける量（0〜1。あくびなど） */
  mouthOpen: number
  /** 表情（モデルが持っていれば出す）と強さ（0〜1） */
  emotion?: 'happy' | 'relaxed'
  /** 体を左右に揺らす量（ラジアン。腰を傾け、脚と背骨で戻して足は地面に残す） */
  swayZ: number
  strength: number
  /** 目を閉じて笑う形（0〜1） */
  eyeSmile: number
  /** 口の形（ほほえみなど）と強さ */
  mouth?: MouthShape
  mouthAmount: number
}

const NO_OFFSET: GestureOffset = { headX: 0, headY: 0, headZ: 0, lean: 0, eyeClose: 0, mouthOpen: 0, strength: 0, eyeSmile: 0, mouthAmount: 0, swayZ: 0 }

/** 立ち上がって、しばらく保って、戻る（rise・fall は全体に対する割合） */
function hold(t: number, rise = 0.2, fall = 0.2): number {
  const smooth = (u: number) => u * u * (3 - 2 * u)
  if (t <= 0 || t >= 1) return 0
  if (t < rise) return smooth(t / rise)
  if (t > 1 - fall) return smooth((1 - t) / fall)
  return 1
}

/** 0→1→0 となめらかに盛り上がる山。from〜to の間だけ値を持つ */
function bell(t: number, from = 0, to = 1): number {
  if (t <= from || t >= to) return 0
  const u = (t - from) / (to - from)
  return Math.sin(Math.PI * u) ** 2
}

/** 身ぶりごとの長さ（秒）と、進み具合 t（0〜1）でのずれ */
const GESTURES: Record<Gesture, { duration: number; offset: (t: number) => Partial<GestureOffset> }> = {
  // ゆっくり左を見て、右を見て、正面に戻る
  lookAround: {
    duration: 4,
    offset: (t) => ({ headY: Math.sin(Math.PI * 2 * t) * 0.35 * bell(t, 0, 1) ** 0.3, headX: -0.04 * bell(t) }),
  },
  // 不思議そうに首をかしげる
  tilt: { duration: 1.8, offset: (t) => ({ headZ: 0.16 * bell(t), headX: -0.03 * bell(t) }) },
  // 口を大きく開けてあくびをし、目を細める
  yawn: {
    duration: 3.2,
    offset: (t) => {
      const b = bell(t, 0.1, 0.9)
      return { mouthOpen: 0.75 * b, eyeClose: 0.8 * b, headX: -0.14 * b, headZ: 0.05 * b }
    },
  },
  // ふっと思い出したように、首をかしげて顔を上げ、にっこりほほえむ
  smile: {
    duration: 3.6,
    offset: (t) => {
      const h = hold(t, 0.22, 0.28)
      return {
        headZ: 0.14 * h,
        headX: -0.07 * h,
        headY: 0.08 * h,
        lean: -0.02 * h,
        emotion: 'happy',
        strength: 0.95 * h,
        mouth: 'smile',
        mouthAmount: 0.9 * h,
        eyeSmile: 0.5 * bell(t, 0.2, 0.8),
      }
    },
  },
  // リズムに乗る：拍に合わせて首を左右に振り、体も左右に揺らして、拍ごとに軽く弾む
  groove: {
    duration: 6,
    offset: (t) => {
      const h = hold(t, 0.12, 0.15)
      // 1拍 0.75 秒（6 秒で 8 拍）。左右は2拍で1往復
      const beat = Math.PI * 2 * 4 * t
      const side = Math.sin(beat) * h
      const bounce = (0.5 - 0.5 * Math.cos(beat * 2)) * h
      return {
        headZ: 0.12 * side,
        headY: 0.06 * side,
        headX: 0.04 * bounce,
        swayZ: 0.045 * side,
        lean: 0.02 * bounce,
        emotion: 'happy',
        strength: 0.6 * h,
        mouth: 'smile',
        mouthAmount: 0.6 * h,
        eyeClose: 0.15 * h,
      }
    },
  },
  // はっと顔を上げて目を覚ます
  wake: {
    duration: 1.4,
    offset: (t) => ({ headX: -0.14 * bell(t, 0, 0.6), lean: -0.04 * bell(t, 0, 0.6) }),
  },
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/**
 * 待機モーション。土台の待機（重心移動・呼吸・下ろした腕と指の形、motion/base.ts）の上に、
 * 会話の様子に合わせた姿勢（MotionState）・身ぶり（Gesture）・居眠り（IdleMood）を重ね、
 * まばたき・視線と合わせてボーンに当てる。
 */
export class IdleMotion {
  /** モデルが持っている機能（指・胸上部・ウインクなど） */
  readonly rig: RigInfo
  private readonly base: BaseIdle
  /** 関節ごとのばね（遅れ・行き過ぎ） */
  private readonly spring = new PoseSpring()
  /** 動きのファイル（.vrma）の再生の重みと、動かしているボーン */
  private clipDrive: ClipDrive = { weight: 0, gestureWeight: 0, faceTouchWeight: 0, bones: new Set(), hipsPosition: false, rotation: () => null, hips: null }
  /** 今のフレームで、動きのファイルが作ったボーンの向き */
  private readonly clipBase = new Map<VRMHumanBoneName, THREE.Quaternion>()
  /** 感情の姿勢・文の終わりのうなずき */
  private readonly expressive: ExpressiveMotion
  private elapsed = 0
  private nextBlinkAt = randomBetween(BLINK_INTERVAL_MIN, BLINK_INTERVAL_MAX)
  private blinkStartedAt = -1
  private nextGazeAt = 0
  private readonly gazeTarget = new THREE.Object3D()
  private readonly gazeGoal = new THREE.Vector3()
  private readonly baseHips = new THREE.Vector3()
  /**
   * VRM 0.x は rotateVRM0 で Y 軸まわりに 180° 回して表示しているため、
   * ボーンのローカル軸が 1.0 と逆向きになる。X・Z 回転の符号をこれで合わせる
   */
  private readonly axisSign: number

  private state: MotionState = 'idle'
  /** 今の姿勢。目標（POSTURES[state]）になめらかに近づける */
  private readonly posture: Posture = { ...POSTURES.idle }
  private nodStartedAt = -1

  private mood: IdleMood = 'awake'
  /** 居眠りの度合い（0〜1）。まぶたと姿勢をゆっくり移す */
  private doze = 0
  private gesture: Gesture | null = null
  private gestureStartedAt = 0
  private offset: GestureOffset = NO_OFFSET
  /** マウスの位置（カメラの前の面の上の点）と、最後に動いた時刻 */
  private readonly pointer = new THREE.Vector3()
  private pointerAt = -Infinity
  /** マウスを追う向き（なめらかに移した値）と、体（腰〜胸）が受け持っている向き */
  private lookYaw = 0
  private lookPitch = 0
  private torsoYaw = 0
  private torsoPitch = 0
  /** 前のフレームで回したボーン（今回回さなかったものは元に戻す） */
  private touched = new Set<VRMHumanBoneName>()
  /** このコマで向きを書いたボーン（腰回りの処理で、前のコマの値に重ねてしまわないため） */
  private written = new Set<VRMHumanBoneName>()
  /** 腰回りの処理で背骨から胸へ移す割合（0 で移さない） */
  private waistShare = STEADY_WAIST_SHARE
  /** 腰回りの処理をする前の、背骨と胸の向き（このコマで書かれなかったときに使う） */
  private readonly spineRaw = new THREE.Quaternion()
  private readonly upperRaw = new THREE.Quaternion()
  /** 動きのファイルに合わせて閉じるまぶた（0〜1。viewer が毎フレーム渡す） */
  private faceEyeClose = 0
  /** 基本の姿勢での頭の位置（腰の親の座標）。動きのファイルで頭が横へ寄りすぎたときに戻す基準 */
  private headRest: THREE.Vector3 | null = null

  constructor(
    private readonly vrm: VRM,
    private readonly camera: THREE.Camera,
  ) {
    this.axisSign = vrm.meta.metaVersion === '0' ? -1 : 1
    this.rig = inspectRig(vrm)
    this.base = new BaseIdle(this.rig)
    this.expressive = new ExpressiveMotion()
    this.baseHips.copy(this.bone('hips')?.position ?? new THREE.Vector3())
    this.headRest = this.headInHipsParent(new THREE.Vector3())
    // 読み込み直後から腕を下ろしておく（揺れものの初期状態をこの姿勢にするため）
    this.applyPose({
      leftUpperArm: [0, 0, -ARM_REST],
      rightUpperArm: [0, 0, ARM_REST],
      leftLowerArm: [0, -0.2, 0],
      rightLowerArm: [0, 0.2, 0],
    }, 0)
    this.gazeTarget.position.copy(camera.position)
    this.gazeGoal.copy(camera.position)
    if (vrm.lookAt) vrm.lookAt.target = this.gazeTarget
  }

  setState(state: MotionState): void {
    if (state === this.state) return
    this.state = state
    // 視線はすぐに新しい向きへ動かし始める
    this.nextGazeAt = this.elapsed
    // 会話が始まったら、身ぶりはやめる
    if (state !== 'idle') this.gesture = null
    this.expressive.setSpeaking(state === 'speaking')
  }

  /** 動きのファイルに合わせて閉じるまぶた（あくびなど）。まばたき・居眠りの大きい方と合わせる */
  setFaceEyeClose(amount: number): void {
    this.faceEyeClose = Math.min(1, Math.max(0, amount))
  }

  /** 動きのファイルの再生の重みと、動かしているボーン（毎フレーム、ファイルを再生したあとに渡す） */
  setClipDrive(drive: ClipDrive): void {
    this.clipDrive = drive
  }


  /** 感情を体の姿勢でも表す（顔の表情は expression.ts） */
  setEmotion(emotion: Emotion): void {
    this.expressive.setEmotion(emotion)
  }

  /** 話すときの合図（文の終わりでうなずき・首かしげ） */
  speechCue(cue: SpeechCue): void {
    this.expressive.cue(cue)
  }

  /** 会話していないときの過ごし方。会話中（idle 以外）は居眠りしない */
  setMood(mood: IdleMood): void {
    this.mood = mood
  }

  /** 動きの元気さ（0〜1）。速さと大きさに効く */
  setEnergy(energy: number): void {
    this.base.energy = Math.min(1, Math.max(0, energy))
  }

  /** 身ぶりを1回する。会話中は無視する（目覚めだけはいつでもする） */
  playGesture(gesture: Gesture): void {
    if (this.state !== 'idle' && gesture !== 'wake') return
    this.gesture = gesture
    this.gestureStartedAt = this.elapsed
  }

  /** 身ぶりの最中か */
  get isGesturing(): boolean {
    return this.gesture !== null
  }

  /** あくびなどで口を開ける量。口パクが無いときに使う */
  get mouthOpen(): number {
    return this.offset.mouthOpen
  }

  /** 身ぶりに合わせた表情（ほほえむ・くつろぐなど）。まぶたの閉じはまばたきに混ぜて出すので、ここでは 0 */
  get face(): FaceNow {
    const o = this.offset
    return {
      emotion: o.emotion,
      strength: o.strength,
      eyeClose: 0,
      eyeSmile: o.eyeSmile,
      mouthOpen: o.mouthOpen,
      mouths: o.mouth ? { [o.mouth]: o.mouthAmount } : {},
    }
  }

  /** マウスが動いた位置（ワールド座標）。しばらく目で追う */
  lookAtPointer(point: THREE.Vector3): void {
    this.pointer.copy(point)
    this.pointerAt = this.elapsed
  }

  /** 小さく1回うなずく */
  nod(): void {
    this.nodStartedAt = this.elapsed
  }

  private bone(name: VRMHumanBoneName): THREE.Object3D | null {
    return this.vrm.humanoid.getNormalizedBoneNode(name)
  }

  /**
   * ポーズをボーンに当てる（回転は VRM 1.0 の向き）。目標へは関節ごとのばね（motion/spring.ts）で近づけるので、
   * 少し遅れてついてきて、止まるときに少し行き過ぎて戻る。
   * 前回回して今回回さないボーンも、急に戻さずばねで元の向きへ戻す
   */
  private applyPose(pose: Pose, delta: number): void {
    const now = new Set<VRMHumanBoneName>()
    for (const [name, r] of Object.entries(pose) as [VRMHumanBoneName, Rotation][]) {
      const node = this.bone(name)
      if (!node) continue
      tmpEuler.set(r[0] * this.axisSign, r[1], r[2] * this.axisSign)
      tmpTarget.setFromEuler(tmpEuler)
      node.quaternion.copy(this.baseOf(name)).multiply(this.spring.step(name, tmpTarget, delta))
      now.add(name)
      this.written.add(name)
    }
    for (const name of this.touched) {
      if (now.has(name)) continue
      const node = this.bone(name)
      if (!node) continue
      const q = this.spring.step(name, IDENTITY, delta)
      node.quaternion.copy(this.baseOf(name)).multiply(q)
      this.written.add(name)
      // 元の向きに戻りきったら、ばねの計算をやめる
      if (Math.abs(q.w) < 0.99999) now.add(name)
    }
    this.touched = now
  }

  /** 動きのファイルが作った向き（無ければ回転なし）。コードの動きはこれに差分として重ねる */
  private baseOf(name: VRMHumanBoneName): THREE.Quaternion {
    return this.clipBase.get(name) ?? IDENTITY
  }

  /** 居眠りするのは、会話していないときだけ */
  private get dozing(): boolean {
    return this.state === 'idle' && this.mood === 'dozing'
  }

  update(delta: number): void {
    this.elapsed += delta
    this.updateGesture()
    this.updatePosture(delta)

    // 1. 土台の待機（重心移動・呼吸・腕・指・頭の揺らぎ）
    const pose: Pose = {}
    // 動きのファイルが動かしているボーンは、その向きを基準にする。
    // 土台の待機は、腕を下ろすなどの形はファイルに任せ、呼吸・重心移動・揺らぎはその上に重ねる（ファイルだけだと棒立ちに見えるため）
    const drive = this.clipDrive
    const extras = this.base.update(delta, pose, this.doze, (bone) => (drive.bones.has(bone) ? drive.weight : 0))
    this.clipBase.clear()
    for (const name of drive.bones) {
      const q = drive.rotation(name)
      if (!q || !this.bone(name)) continue
      this.clipBase.set(name, q.clone())
    }
    const hips = this.bone('hips')
    if (hips) {
      // 腰の揺れも、1回きりの動きの最中だけ弱める
      const k = drive.hipsPosition ? 1 - drive.gestureWeight : 1
      // 動きのファイルが腰の位置を動かしていれば、その位置と基本の位置を重みで混ぜたものを基準にする
      const clipHips = drive.hipsPosition ? drive.hips : null
      const baseX = clipHips ? this.baseHips.x + (clipHips.x - this.baseHips.x) * drive.weight : this.baseHips.x
      const baseY = clipHips ? this.baseHips.y + (clipHips.y - this.baseHips.y) * drive.weight : this.baseHips.y
      if (clipHips) hips.position.z = this.baseHips.z + (clipHips.z - this.baseHips.z) * drive.weight
      hips.position.x = baseX + extras.hipsX * this.axisSign * k
      hips.position.y = baseY + extras.hipsY * k
    }

    // 2. 会話の様子・居眠りによる姿勢、感情の姿勢・文の終わりのうなずき
    addRotation(pose, 'spine', this.blended('lean') + this.offset.lean, 0, 0)
    this.addSway(pose, this.offset.swayZ)
    this.addHead(pose, delta)
    // 話している間の手の動きは、腕を動かす動きのファイルが流れていれば、その分だけ弱める
    const armsByFile = drive.bones.has('leftLowerArm') || drive.bones.has('rightLowerArm') ? drive.weight : 0
    this.expressive.update(delta, pose, 1 - armsByFile)

    // 1回きりの動きのファイル（あいさつ・喜ぶなど）の最中は、腕と手はファイルに任せる。
    // 呼吸などのコードの動きを重ねると、ファイルの身ぶりが崩れて見えなくなるため
    const own = drive.gestureWeight
    if (own > 0.001) {
      const k = 1 - own
      for (const [name, r] of Object.entries(pose) as [VRMHumanBoneName, Rotation][]) {
        if (!ARM_BONE.test(name) || !drive.bones.has(name)) continue
        r[0] *= k
        r[1] *= k
        r[2] *= k
      }
    }
    // 顔に手を当てる動き（あごに手など）の最中は、首・頭・腕のコードの動きも弱める。
    // 首をかしげる・マウスを追うなどで頭だけが回ると、あごが手から離れて見えるため（目はマウスを追い続ける）
    const touch = drive.faceTouchWeight
    if (touch > 0.001) {
      const k = 1 - touch
      for (const [name, r] of Object.entries(pose) as [VRMHumanBoneName, Rotation][]) {
        if (name !== 'neck' && name !== 'head' && !(ARM_BONE.test(name) && drive.bones.has(name))) continue
        r[0] *= k
        r[1] *= k
        r[2] *= k
      }
    }

    this.written.clear()
    this.applyPose(pose, delta)
    this.steadyWaist()
    if (drive.weight > 0.001) this.keepHeadInPlace()
    this.updateBlink()
    this.updateGaze(delta)
  }

  /** 話している間に手ぶりをするか（キャラクターごと） */
  setTalkGestures(on: boolean): void {
    this.expressive.setGestures(on)
  }

  /** 腰回りを崩れにくくする（背骨の回転の多くを胸へ移す）。オフにすると今までどおり */
  setSteadyWaist(on: boolean): void {
    this.waistShare = on ? STEADY_WAIST_SHARE : 0
  }

  /**
   * 背骨の回転の一部を、すぐ上の胸（無ければ胸上部）へ移す。胸から上の向きはそのままで、背骨と、背骨にぶら下がる
   * 腰の飾りなどだけが回りにくくなる。前のコマの結果に重ねないよう、このコマで書かれた向き（無ければ前の元の向き）から作る
   */
  private steadyWaist(): void {
    const spine = this.bone('spine')
    const upperName: VRMHumanBoneName = this.bone('chest') ? 'chest' : 'upperChest'
    const upper = this.bone(upperName)
    if (!spine || !upper) return
    if (this.written.has('spine')) this.spineRaw.copy(spine.quaternion)
    if (this.written.has(upperName)) this.upperRaw.copy(upper.quaternion)
    if (this.waistShare <= 0) {
      spine.quaternion.copy(this.spineRaw)
      upper.quaternion.copy(this.upperRaw)
      return
    }
    // 背骨に残す向き（回転の一部）と、胸へ移すぶん（残した向きの逆 × 元の背骨）
    const kept = tmpQuat.identity().slerp(this.spineRaw, 1 - this.waistShare)
    const moved = new THREE.Quaternion().copy(kept).invert().multiply(this.spineRaw)
    spine.quaternion.copy(kept)
    upper.quaternion.copy(moved).multiply(this.upperRaw)
  }

  /** 頭の位置を、腰の親の座標で求める（頭が無ければ null） */
  private headInHipsParent(out: THREE.Vector3): THREE.Vector3 | null {
    const head = this.bone('head')
    const parent = this.bone('hips')?.parent
    if (!head || !parent) return null
    this.vrm.humanoid.normalizedHumanBonesRoot.updateWorldMatrix(true, true)
    return parent.worldToLocal(head.getWorldPosition(out))
  }

  /**
   * その場にとどめる（仕上げ）：動きのファイルで頭が横へ大きく寄ったら、腰を反対へずらして頭を画面の中に戻す。
   * 体をひねったままかがむ動きなどは、ボーンごとに角度を抑えても頭が横へ出てしまうため。
   * 小さな寄りはそのまま残し、大きいほど強く戻す（柔らかい上限）。前後（おじぎ）は戻さない
   */
  private keepHeadInPlace(): void {
    const hips = this.bone('hips')
    const rest = this.headRest
    if (!hips || !rest) return
    const now = this.headInHipsParent(tmpGoal)
    if (!now) return
    const dx = now.x - rest.x
    const limit = MAX_HEAD_SIDE * Math.max(this.baseHips.y, 0.1)
    const kept = softLimit(dx, limit)
    if (Math.abs(dx - kept) < 1e-4) return
    hips.position.x -= dx - kept
  }

  /**
   * 体を左右に揺らす（リズムに乗る）。腰を傾け、脚は反対に戻して足を地面に残し、背骨・胸で戻して頭が大きく振れないようにする
   */
  private addSway(pose: Pose, sway: number): void {
    if (Math.abs(sway) < 1e-4) return
    addRotation(pose, 'hips', 0, 0, sway)
    addRotation(pose, 'leftUpperLeg', 0, 0, -sway)
    addRotation(pose, 'rightUpperLeg', 0, 0, -sway)
    addRotation(pose, 'spine', 0, 0, -sway * 0.5)
    addRotation(pose, this.rig.hasChest ? 'chest' : 'spine', 0, 0, -sway * 0.3)
  }

  private updateGesture(): void {
    if (!this.gesture) {
      this.offset = NO_OFFSET
      return
    }
    const g = GESTURES[this.gesture]
    const t = (this.elapsed - this.gestureStartedAt) / g.duration
    if (t >= 1) {
      this.gesture = null
      this.offset = NO_OFFSET
      return
    }
    this.offset = { ...NO_OFFSET, ...g.offset(t) }
  }

  private updatePosture(delta: number): void {
    const target = POSTURES[this.state]
    const t = 1 - Math.exp(-delta / POSTURE_SMOOTHING)
    for (const key of Object.keys(target) as (keyof Posture)[]) {
      this.posture[key] += (target[key] - this.posture[key]) * t
    }
    this.doze += ((this.dozing ? 1 : 0) - this.doze) * (1 - Math.exp(-delta / DOZE_SMOOTHING))
  }

  /** 居眠りの度合いで、ふつうの姿勢と居眠りの姿勢を混ぜる */
  private blended(key: keyof Posture): number {
    return this.posture[key] * (1 - this.doze) + DOZE_POSTURE[key] * this.doze
  }

  private updateBlink(): void {
    const manager = this.vrm.expressionManager
    if (!manager) return

    if (this.blinkStartedAt < 0 && this.elapsed >= this.nextBlinkAt) {
      this.blinkStartedAt = this.elapsed
    }
    let blink = 0
    if (this.blinkStartedAt >= 0) {
      const t = (this.elapsed - this.blinkStartedAt) / BLINK_DURATION
      if (t >= 1) {
        this.blinkStartedAt = -1
        // ときどき2回続けてまばたきする。考えている間は、まばたきを少し増やす
        const scale = this.state === 'thinking' ? 0.6 : 1
        this.nextBlinkAt =
          Math.random() < DOUBLE_BLINK_CHANCE
            ? this.elapsed + 0.12
            : this.elapsed + randomBetween(BLINK_INTERVAL_MIN, BLINK_INTERVAL_MAX) * scale
      } else {
        blink = Math.sin(Math.PI * t)
      }
    }
    // 居眠り・身ぶり・動きのファイルで閉じるまぶたと、まばたきの大きい方
    manager.setValue('blink', Math.min(1, Math.max(blink, this.doze, this.offset.eyeClose, this.faceEyeClose)))
  }

  /**
   * マウスを目で追っているか（居眠りしていない・身ぶりの最中でない・最近動いた）。
   * 考え中・作業中・話している間も追う（Claude との作業中は待機に戻る時間が短く、待機中だけだとほとんど追わなくなるため）
   */
  private get followingPointer(): boolean {
    return this.doze < 0.5 && !this.gesture && this.elapsed - this.pointerAt < POINTER_GAZE_SECONDS
  }

  /** 姿勢の頭の向きに、様子ごとの小さな揺れとうなずきを足して、首と頭に分けて回す */
  private addHead(pose: Pose, delta: number): void {
    const e = this.elapsed
    let x = this.blended('headX') + this.offset.headX
    let y = this.blended('headY') + this.offset.headY
    let z = this.blended('headZ') + this.offset.headZ
    switch (this.state) {
      case 'thinking':
        // ゆっくり首を振るように揺れる
        y += Math.sin(e * 0.9) * 0.05
        z += Math.sin(e * 0.6) * 0.03
        break
      case 'working':
        // 手元を確かめるように、首を左右・前後に軽く振る
        y += Math.sin(e * 1.3) * 0.09
        x += Math.sin(e * 2.1 + 1) * 0.05
        break
      case 'speaking':
        // 話に合わせて軽く揺れる
        x += Math.sin(e * 4.4) * 0.018
        y += Math.sin(e * 1.3) * 0.03
        break
      default:
        // 居眠り中は、ときどきこくりと頭が落ちる
        x += Math.max(0, Math.sin(e * 0.5)) ** 8 * 0.14 * this.doze
    }
    // マウスを追う向き。追い始め・やめるときに急に向きが変わらないよう、なめらかに移す
    const cam = this.camera.position
    const targetYaw = this.followingPointer
      ? THREE.MathUtils.clamp((this.pointer.x - cam.x) * POINTER_HEAD_FOLLOW, -POINTER_MAX_YAW, POINTER_MAX_YAW)
      : 0
    const targetPitch = this.followingPointer
      ? -THREE.MathUtils.clamp((this.pointer.y - cam.y) * POINTER_HEAD_FOLLOW, -POINTER_MAX_PITCH, POINTER_MAX_PITCH)
      : 0
    const kLook = 1 - Math.exp(-delta / POINTER_SMOOTHING)
    this.lookYaw += (targetYaw - this.lookYaw) * kLook
    this.lookPitch += (targetPitch - this.lookPitch) * kLook
    y += this.lookYaw
    x += this.lookPitch

    // 向きたい角度の一部を、腰から胸までが少し遅れて受け持つ（目 → 頭 → 首 → 胸 → 背骨 → 腰の順に向く）。
    // 首から上だけがねじれて、髪や襟が体にめり込むのを防ぐ
    const kTorso = 1 - Math.exp(-delta / TORSO_SMOOTHING)
    this.torsoYaw += (y * TORSO_YAW_SHARE - this.torsoYaw) * kTorso
    this.torsoPitch += (x * TORSO_PITCH_SHARE - this.torsoPitch) * kTorso
    this.addTorsoTurn(pose, this.torsoPitch, this.torsoYaw)
    x -= this.torsoPitch
    y -= this.torsoYaw

    // うなずきは頭と首だけで速く動かす（体は遅れてついてこない）
    if (this.nodStartedAt >= 0) {
      const t = (e - this.nodStartedAt) / NOD_DURATION
      if (t >= 1) this.nodStartedAt = -1
      else x += Math.sin(Math.PI * t) * NOD_DEPTH
    }
    addRotation(pose, 'neck', x * 0.4, y * 0.4, z * 0.4)
    addRotation(pose, 'head', x * 0.6, y * 0.6, z * 0.6)
  }

  /**
   * 体の向き（前かがみ・ひねり）を、腰・背骨・胸・胸上部に分けて回す。無い部位の分は近くの部位がまとめて受け持つ。
   * 左右のひねりは腰からまとめて回し、胸と腰の向きの差を小さくする。
   * 胸だけを大きくひねると、胸と一緒に回る腕と、腰に付いて動く服（コートの裾・スカートなど）がずれて重なるため
   */
  private addTorsoTurn(pose: Pose, pitch: number, yaw: number): void {
    const { hasChest, hasUpperChest } = this.rig
    const chestYaw = hasChest ? (hasUpperChest ? 0.1 : 0.15) : 0
    const upperYaw = hasChest && hasUpperChest ? 0.05 : 0
    const spineYaw = 1 - HIPS_YAW_SHARE - chestYaw - upperYaw
    addRotation(pose, 'hips', 0, yaw * HIPS_YAW_SHARE, 0)
    addRotation(pose, 'spine', pitch * (hasChest ? 0.5 : 1), yaw * spineYaw, 0)
    if (hasChest) addRotation(pose, 'chest', pitch * 0.5, yaw * chestYaw, 0)
    if (upperYaw) addRotation(pose, 'upperChest', 0, yaw * upperYaw, 0)
  }

  private updateGaze(delta: number): void {
    const cam = this.camera.position
    if (this.followingPointer) {
      this.gazeGoal.copy(this.pointer)
    } else if (this.elapsed >= this.nextGazeAt) {
      // 考え中・作業中は視線をそらしたまま、あまりさまよわせない
      const wander = this.state === 'thinking' || this.state === 'working' ? 0.3 : 1
      this.nextGazeAt = this.elapsed + randomBetween(GAZE_INTERVAL_MIN, GAZE_INTERVAL_MAX)
      const goal = POSTURES[this.state]
      this.gazeGoal.set(
        cam.x + goal.gazeX + randomBetween(-GAZE_RANGE, GAZE_RANGE) * wander,
        cam.y + goal.gazeY + randomBetween(-GAZE_RANGE, GAZE_RANGE) * 0.5 * wander,
        cam.z,
      )
    }
    // 見回すなどの身ぶりの間は、視線も頭と一緒に動かす
    const look = this.offset.headY * 1.5
    const down = this.offset.headX > 0.1 ? -this.offset.headX * 0.8 : 0
    const goal = look || down ? this.gazeGoal.clone().setX(this.gazeGoal.x + look).setY(this.gazeGoal.y + down) : this.gazeGoal
    this.gazeTarget.position.lerp(goal, 1 - Math.exp(-delta * (this.followingPointer ? 4 : 1.5)))
  }
}

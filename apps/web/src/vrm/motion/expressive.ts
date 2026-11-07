import type { Emotion } from '@aicarnation/shared'
import { SIDES, addPose, addRotation, sideSign, type Pose } from './pose'

/**
 * 感情と話し方を体でも小さく表す動き。どれも土台の待機（base.ts）に足し算で重ね、切り替えはなめらかに移す。
 * 感情は、どのモデルでも崩れないよう、背骨・胸・首・頭のわずかな傾きだけで表す。
 * 腕を使うのは話している間だけ：肘を脇に置いたまま前腕を前と外へ開き、指を開いた手のひらを上と前（相手の方）へ見せて、軽く上下させる。
 * それ以外の手ぶりや腕を使う身ぶりは、利用者が動きのファイルで入れる
 */

/** 姿勢を切り替えるときの追従の速さ（秒） */
const POSE_SMOOTHING = 0.45

/** 感情ごとの体の姿勢（顔の表情は expression.ts。ここは体だけ） */
const EMOTION_POSES: Record<Exclude<Emotion, 'neutral'>, Pose> = {
  // 胸を張って、顔を少し上げる
  happy: { spine: [-0.02, 0, 0], chest: [-0.03, 0, 0], head: [-0.04, 0, 0] },
  // 少しうつむく
  sad: { spine: [0.04, 0, 0], chest: [0.03, 0, 0], neck: [0.04, 0, 0], head: [0.08, 0, 0] },
  // 少しのけぞって、顔を上げる
  surprised: { spine: [-0.03, 0, 0], head: [-0.06, 0, 0] },
  // 少し前のめりで、あごを引く
  angry: { spine: [0.03, 0, 0], head: [0.05, 0, 0] },
  // 力を抜いて、首を少しかしげる
  relaxed: { head: [0, 0, 0.05] },
}

/**
 * 話している間の腕の形（左腕の値。右は左右反転）。語りかけるときの、両手を開いて見せる手ぶり：
 * 肘は脇に置いたまま、前腕を前と少し外へ開いて手を胸の下の高さへ上げ、手のひらを上と前へ向けて指先を外へ開く
 */
const TALK_ARM = {
  /** 上腕：少し前へ出し（x 負）、肘を体から少し離す（z） */
  upper: [-0.3, 0, 0.08],
  /** 前腕：外へ開き（x 負）、肘を曲げて手を上げる（y） */
  lower: [-0.4, -1.4, 0],
  /** 手首：手のひらを上と前へ返し、指先を外へ向ける */
  hand: [-0.5, -0.5, 0.5],
}
/** 話している間に指を開く量（土台の待機で軽く曲げている指を、この割合だけ伸ばす） */
const TALK_FINGER_OPEN = 0.25
/** 親指以外の指 */
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const
/** 話している間の手の上下（前腕の曲げの揺れ、ラジアン）と速さ（1 秒あたりの往復） */
const TALK_BOB = 0.1
const TALK_BOB_RATE = 1.4
/** 話し始め・話し終えで、腕を上げ下ろしする速さ（秒） */
const TALK_SMOOTHING = 0.35

/** 話すときの合図 */
export type SpeechCue =
  /** 文を話し始めた */
  | { type: 'sentenceStart' }
  /** 読点・強調など、話の区切り */
  | { type: 'beat' }
  /** 文を話し終えた（うなずく。問いかけなら首をかしげる） */
  | { type: 'sentenceEnd'; question: boolean }

/**
 * 感情の姿勢と、文の終わりのうなずき・首かしげをまとめて動かす
 */
export class ExpressiveMotion {
  private elapsed = 0
  /** 感情ごとの姿勢の重み（なめらかに移す） */
  private readonly emotionWeights = new Map<Exclude<Emotion, 'neutral'>, number>()
  private emotion: Emotion = 'neutral'
  /** 文の終わりのうなずき・首かしげ */
  private endCue: { at: number; question: boolean } | null = null
  private speaking = false
  /** 話している間の腕の形（調整しやすいよう、インスタンスから参照する） */
  readonly talkArm = TALK_ARM
  /** 話している間の腕の形の重み（なめらかに移す） */
  private talk = 0

  setEmotion(emotion: Emotion): void {
    this.emotion = emotion
  }

  /** 話している間か（手を前に上げて、軽く上下させる） */
  setSpeaking(speaking: boolean): void {
    this.speaking = speaking
  }

  /** 話している間に手ぶりをするか（キャラクターごと。切ると腕は下ろしたまま） */
  private gestures = true
  setGestures(on: boolean): void {
    this.gestures = on
  }

  /** 話すときの合図。文の終わりでだけ頭を動かす（文の頭・区切りでは何もしない） */
  cue(cue: SpeechCue): void {
    if (cue.type === 'sentenceEnd') this.endCue = { at: this.elapsed, question: cue.question }
  }

  /** 時間を進めて、この瞬間の姿勢を pose に足す。armScale は腕の動きの強さ（腕を動かす動きのファイルが流れていれば弱める） */
  update(delta: number, pose: Pose, armScale = 1): void {
    this.elapsed += delta
    const k = 1 - Math.exp(-delta / POSE_SMOOTHING)

    // --- 感情の姿勢 ---
    for (const [emotion, emotionPose] of Object.entries(EMOTION_POSES) as [Exclude<Emotion, 'neutral'>, Pose][]) {
      const current = this.emotionWeights.get(emotion) ?? 0
      const next = current + ((this.emotion === emotion ? 1 : 0) - current) * k
      this.emotionWeights.set(emotion, next)
      if (next >= 0.001) addPose(pose, emotionPose, next)
    }

    // --- 話している間の手：両手を開いて手のひらを見せ、軽く上下させる ---
    this.talk += ((this.speaking && this.gestures ? 1 : 0) - this.talk) * (1 - Math.exp(-delta / TALK_SMOOTHING))
    const w = this.talk * Math.min(1, Math.max(0, armScale))
    if (w > 0.001) {
      for (const side of SIDES) {
        const s = sideSign(side)
        // 左右で少しずらして上下させる
        const bob = Math.sin(this.elapsed * Math.PI * 2 * TALK_BOB_RATE + (side === 'left' ? 0 : 1.3)) * TALK_BOB
        // 左右対称にするには、x はそのまま、y・z は左右で符号を反転する
        const a = this.talkArm
        addRotation(pose, `${side}UpperArm`, a.upper[0]! * w, s * a.upper[1]! * w, s * a.upper[2]! * w)
        addRotation(pose, `${side}LowerArm`, a.lower[0]! * w, s * (a.lower[1]! + bob) * w, s * a.lower[2]! * w)
        addRotation(pose, `${side}Hand`, a.hand[0]! * w, s * a.hand[1]! * w, s * a.hand[2]! * w)
        // 指を開く（曲げと逆向きに回す。指のボーンが無いモデルでは何もしない）
        for (const finger of FINGERS) {
          for (const joint of ['Proximal', 'Intermediate'] as const) {
            addRotation(pose, `${side}${finger}${joint}`, 0, 0, s * TALK_FINGER_OPEN * w)
          }
        }
      }
    }

    // --- 文の終わり：うなずく／首をかしげる ---
    if (this.endCue) {
      const u = (this.elapsed - this.endCue.at) / (this.endCue.question ? 1.3 : 0.8)
      if (u >= 1) {
        this.endCue = null
      } else {
        const env = Math.sin(Math.PI * u)
        if (this.endCue.question) {
          addRotation(pose, 'head', -0.06 * env, 0.05 * env, 0.24 * env)
          addRotation(pose, 'neck', 0, 0, 0.06 * env)
        } else {
          addRotation(pose, 'head', 0.16 * env, 0, 0)
          addRotation(pose, 'neck', 0.06 * env, 0, 0)
        }
      }
    }
  }
}

import type { VRMHumanBoneName } from '@pixiv/three-vrm'
import type { RigInfo } from '../rig'
import { Noise1D } from './noise'
import { SIDES, addRotation, sideSign, type Pose } from './pose'

/** 腕を下ろした姿勢の、上腕の角度（ラジアン） */
export const ARM_REST = 1.2

/** 重心を乗せ替える間隔（秒） */
const WEIGHT_SHIFT_MIN = 4
const WEIGHT_SHIFT_MAX = 12
/** 重心の移り変わりの速さ（秒）。小さいほど素早く乗せ替える */
const WEIGHT_SMOOTHING = 0.9
/** 呼吸の周期（秒）の範囲。揺らぎで少しずつ変える */
const BREATH_PERIOD_MIN = 3.4
const BREATH_PERIOD_MAX = 4.8
/** ときどきする深呼吸の間隔（秒） */
const DEEP_BREATH_MIN = 25
const DEEP_BREATH_MAX = 60

/** 指の曲げ具合（付け根・中・先）。小指ほど深く曲げると自然に見える */
const FINGER_CURL: Record<string, number> = { Index: 0.2, Middle: 0.3, Ring: 0.36, Little: 0.42 }
const FINGER_JOINTS = ['Proximal', 'Intermediate', 'Distal'] as const
const JOINT_FACTOR = [1, 0.85, 0.6]

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** 土台の待機が出す、ボーンの回転以外の動き */
export interface BaseExtras {
  /** 腰の左右のずれ（m） */
  hipsX: number
  /** 腰の上下（呼吸。m） */
  hipsY: number
  /** 呼吸の進み（-1〜1）。胸・肩の動きに使う */
  breath: number
}

/**
 * 土台の待機（どのモデルでも動く、ずっと流れる動き）。
 * - 重心の乗せ替え：数秒〜十数秒おきに体重を左右の足に移し、腰がずれて傾き、反対の膝が軽く曲がる
 * - 呼吸：周期と深さを揺らぎで変え、ときどき深呼吸する
 * - 腕：下ろして肘を軽く曲げた形のまま止めておく（腕は揺らさない。モデルの腕が体や服にめり込まないため）
 * - 指：軽く曲げた自然な形のまま止めておく（指のボーンがあるモデルだけ）
 * - 頭：細かな揺らぎ
 * 速さと大きさは energy（0〜1。のちに個性から決める）で変えられる
 */
export class BaseIdle {
  private elapsed = 0
  /** 重心（-1：右足に乗る 〜 1：左足に乗る） */
  private weight = 0
  private weightTarget = 0
  private nextShiftAt = randomBetween(2, WEIGHT_SHIFT_MAX)
  private breathPhase = 0
  private deepBreathAt = randomBetween(DEEP_BREATH_MIN, DEEP_BREATH_MAX)
  private deepBreathStartedAt = -Infinity
  /** 部位ごとの揺らぎ（種を変えて、ばらばらに動かす） */
  private readonly noise = {
    head: new Noise1D(53),
    headY: new Noise1D(59),
    torso: new Noise1D(67),
    breath: new Noise1D(71),
  }
  /** 左右の腕の基本の角度の違い（モデルを読むたびに少し変える） */
  private readonly armBias = { left: randomBetween(-0.04, 0.04), right: randomBetween(-0.04, 0.04) }

  constructor(
    private readonly rig: RigInfo,
    public energy = 0.5,
  ) {}

  /**
   * 時間を進めて、この瞬間の土台のポーズを作る。slow（0〜1）は居眠りなどで動きをゆっくり小さくする量。
   * driven はボーンごとの、動きのファイルが姿勢を決めている度合い（0〜1）。
   * 決めているボーンでは、腕を下ろす・肘や指を曲げるといった「形」はファイルに任せ、呼吸や揺らぎだけを重ねる
   */
  update(delta: number, pose: Pose, slow = 0, driven: (bone: VRMHumanBoneName) => number = () => 0): BaseExtras {
    this.elapsed += delta
    const t = this.elapsed
    const activity = (0.6 + this.energy * 0.8) * (1 - slow * 0.7)

    // --- 重心の乗せ替え ---
    if (t >= this.nextShiftAt) {
      const choices = [-1, -0.45, 0.45, 1]
      let next = choices[Math.floor(Math.random() * choices.length)] ?? 0
      // 同じ側に乗せ続けないよう、なるべく反対側へ
      if (Math.sign(next) === Math.sign(this.weightTarget) && Math.random() < 0.7) next = -next
      this.weightTarget = next * (0.7 + this.energy * 0.3)
      this.nextShiftAt = t + randomBetween(WEIGHT_SHIFT_MIN, WEIGHT_SHIFT_MAX) / activity
    }
    this.weight += (this.weightTarget - this.weight) * (1 - Math.exp(-delta / WEIGHT_SMOOTHING))
    const w = this.weight * (1 - slow * 0.5)
    // 腰を重心の側へずらして傾け、脚はまっすぐ立ったままにする。上半身は少し反対へ戻してバランスを取る
    addRotation(pose, 'hips', 0, this.noise.torso.wobble(t * 0.07) * 0.03, w * 0.04)
    addRotation(pose, 'spine', 0, 0, -w * 0.028)
    addRotation(pose, this.rig.hasChest ? 'chest' : 'spine', 0, 0, -w * 0.016)
    for (const side of SIDES) {
      addRotation(pose, `${side}UpperLeg`, 0, 0, -w * 0.04)
      // 体重が乗っていない方の膝を軽く曲げる
      const unloaded = Math.max(0, side === 'left' ? -w : w)
      addRotation(pose, `${side}UpperLeg`, -unloaded * 0.07, 0, 0)
      addRotation(pose, `${side}LowerLeg`, unloaded * 0.14, 0, 0)
      addRotation(pose, `${side}Foot`, -unloaded * 0.06, 0, 0)
    }

    // --- 呼吸 ---
    const period =
      BREATH_PERIOD_MIN + (BREATH_PERIOD_MAX - BREATH_PERIOD_MIN) * (0.5 + this.noise.breath.at(t * 0.05) * 0.5)
    this.breathPhase += (delta / (period * (1 + slow * 0.4))) * Math.PI * 2
    if (t >= this.deepBreathAt) {
      this.deepBreathStartedAt = t
      this.deepBreathAt = t + randomBetween(DEEP_BREATH_MIN, DEEP_BREATH_MAX)
    }
    const deepT = (t - this.deepBreathStartedAt) / 3.5
    const deep = deepT >= 0 && deepT < 1 ? Math.sin(Math.PI * deepT) : 0
    const breath = Math.sin(this.breathPhase)
    const depth = 1 + deep * 1.6 + slow * 0.6
    addRotation(pose, this.rig.hasChest ? 'chest' : 'spine', -breath * 0.014 * depth - deep * 0.02, 0, 0)
    if (this.rig.hasUpperChest) addRotation(pose, 'upperChest', -breath * 0.008 * depth, 0, 0)
    if (this.rig.hasShoulders) {
      const lift = breath * 0.018 * depth + deep * 0.03
      addRotation(pose, 'leftShoulder', 0, 0, lift)
      addRotation(pose, 'rightShoulder', 0, 0, -lift)
    }

    // --- 腕：下ろした形（揺らさない） ---
    for (const side of SIDES) {
      const s = sideSign(side)
      const upper = 1 - driven(`${side}UpperArm`)
      const lower = 1 - driven(`${side}LowerArm`)
      const hand = 1 - driven(`${side}Hand`)
      // 上腕：下ろして（z）、少し前へ（x 負で前）
      addRotation(pose, `${side}UpperArm`, -0.08 * upper, 0, -s * (ARM_REST + this.armBias[side]) * upper)
      // 前腕：肘を軽く曲げる（左は y 負、右は y 正で前へ曲がる）
      addRotation(pose, `${side}LowerArm`, 0, -s * 0.22 * lower, 0)
      // 手首：少し内側に返す
      addRotation(pose, `${side}Hand`, 0, -s * 0.08 * hand, -s * 0.06 * hand)
    }

    // --- 指（指のボーンがあるモデルだけ） ---
    if (this.rig.hasFingers) {
      for (const side of SIDES) {
        const s = sideSign(side)
        for (const [finger, curl] of Object.entries(FINGER_CURL)) {
          FINGER_JOINTS.forEach((joint, i) => {
            const bone = `${side}${finger}${joint}` as VRMHumanBoneName
            addRotation(pose, bone, 0, 0, -s * curl * (1 - driven(bone)) * (JOINT_FACTOR[i] ?? 1))
          })
        }
        if (this.rig.hasThumbs) {
          const proximal = 1 - driven(`${side}ThumbProximal`)
          addRotation(pose, `${side}ThumbProximal`, 0, -s * 0.15 * proximal, -s * 0.1 * proximal)
          addRotation(pose, `${side}ThumbDistal`, 0, 0, -s * 0.15 * (1 - driven(`${side}ThumbDistal`)))
        }
      }
    }

    // --- 頭の細かな揺らぎ ---
    const headScale = activity * (1 - slow)
    addRotation(
      pose,
      'head',
      this.noise.head.wobble(t * 0.15) * 0.025 * headScale,
      this.noise.headY.wobble(t * 0.1) * 0.04 * headScale,
      this.noise.head.wobble(t * 0.12 + 40) * 0.02 * headScale + w * 0.015,
    )

    return { hipsX: w * 0.018, hipsY: breath * 0.003 * depth, breath }
  }
}

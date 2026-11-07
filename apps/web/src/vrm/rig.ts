import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

/**
 * 読み込んだモデルが持っている機能。
 * VRM の規格で必ずあるもの（体の主なボーン・標準の表情）だけで基本の動きを作り、
 * ここで見つかったもの（指・胸上部・ウインク・独自の表情など）は、あれば上乗せして使う
 */
export interface RigInfo {
  /** 指のボーン（左右の人差し指〜小指の付け根）がある */
  hasFingers: boolean
  /** 親指のボーンがある */
  hasThumbs: boolean
  /** 胸上部（upperChest）のボーンがある */
  hasUpperChest: boolean
  /** 胸（chest）のボーンがある */
  hasChest: boolean
  /** 肩（shoulder）のボーンがある */
  hasShoulders: boolean
  /** 左右別のまばたき（ウインク）ができる */
  hasWink: boolean
  /** 揺れもの（髪・服の物理）がある */
  hasSpringBones: boolean
  /** 標準以外の表情の名前（照れ・ジト目など、モデルが独自に持っているもの） */
  customExpressions: string[]
  /** VRM の版（'0' か '1'） */
  version: '0' | '1'
}

const FINGER_ROOTS: VRMHumanBoneName[] = [
  'leftIndexProximal',
  'leftMiddleProximal',
  'leftRingProximal',
  'leftLittleProximal',
  'rightIndexProximal',
  'rightMiddleProximal',
  'rightRingProximal',
  'rightLittleProximal',
]

/** VRM の標準の表情（これ以外は独自の表情） */
const PRESET_EXPRESSIONS = new Set([
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'neutral',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
  'lookUp',
  'lookDown',
  'lookLeft',
  'lookRight',
])

export function inspectRig(vrm: VRM): RigInfo {
  const has = (name: VRMHumanBoneName) => vrm.humanoid.getRawBoneNode(name) != null
  const manager = vrm.expressionManager
  const hasExpression = (name: string) => manager?.getExpression(name) != null
  const customExpressions = (manager?.expressions ?? [])
    .map((e) => e.expressionName)
    // 目元だけの表情（expression.ts が足したもの）は数えない
    .filter((name) => !PRESET_EXPRESSIONS.has(name) && !name.endsWith('-eyes'))
  return {
    hasFingers: FINGER_ROOTS.every(has),
    hasThumbs: has('leftThumbProximal') && has('rightThumbProximal'),
    hasUpperChest: has('upperChest'),
    hasChest: has('chest'),
    hasShoulders: has('leftShoulder') && has('rightShoulder'),
    hasWink: hasExpression('blinkLeft') && hasExpression('blinkRight'),
    hasSpringBones: (vrm.springBoneManager?.joints.size ?? 0) > 0,
    customExpressions,
    version: vrm.meta.metaVersion === '0' ? '0' : '1',
  }
}

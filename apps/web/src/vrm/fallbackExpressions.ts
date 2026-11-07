import * as THREE from 'three'
import { VRMExpression, VRMExpressionMorphTargetBind, type VRM } from '@pixiv/three-vrm'

/**
 * 表情が登録されていないモデルに、顔のモーフの名前から標準の表情（まばたき・口形・感情）を組み立てる。
 * MMD から変換したモデルなどは、顔のモーフ（「あ」「まばたき」「にこり」など）を持っていても、
 * VRM の表情として結び付けられていないことがあり、そのままではまばたき・口パク・表情が動かない。
 * モデルにすでにある表情には手を付けない
 */

/** 材料：モーフ名と強さ。名前は完全一致か、末尾一致（「Face.M_F00_000_Fcl_EYE_Close」のような前置きに対応） */
type Recipe = [string, number][]

/** 表情ごとの材料の候補。上から順に、材料がすべてそろう最初のものを使う */
const RECIPES: Record<string, Recipe[]> = {
  blink: [
    [['まばたき', 1]],
    [['ウィンク', 1], ['ウィンク右', 1]],
    [['Fcl_EYE_Close', 1]],
    [['Blink', 1]],
    [['eye_close', 1]],
  ],
  aa: [[['あ', 1]], [['Fcl_MTH_A', 1]], [['mouth_a', 1]]],
  ih: [[['い', 1]], [['Fcl_MTH_I', 1]], [['mouth_i', 1]]],
  ou: [[['う', 1]], [['Fcl_MTH_U', 1]], [['mouth_u', 1]], [['ω', 0.7]], [['あ', 0.3], ['口横狭め', 0.7]]],
  ee: [[['え', 1]], [['Fcl_MTH_E', 1]], [['mouth_e', 1]]],
  oh: [[['お', 1]], [['Fcl_MTH_O', 1]], [['mouth_o', 1]], [['あ', 0.55], ['口横狭め', 0.6]]],
  // 喜び・くつろぎは目を開けたまま（眉と下まぶたで笑う）。目を閉じて笑う形（なごみ・笑い）は、笑う動きのときだけ eyes-smile で出す
  happy: [
    [['にこり左', 1], ['にこり右', 1], ['下眼上', 0.5]],
    [['にこり', 1], ['下眼上', 0.5]],
    [['にこり左', 1], ['にこり右', 1]],
    [['にこり', 1]],
    [['Fcl_ALL_Joy', 1]],
  ],
  relaxed: [
    [['にこり左', 0.5], ['にこり右', 0.5], ['下眼上', 0.3]],
    [['にこり', 0.5], ['下眼上', 0.3]],
    [['にこり左', 0.5], ['にこり右', 0.5]],
    [['Fcl_ALL_Fun', 1]],
  ],
  angry: [
    [['怒り', 1]],
    [['怒り左', 1], ['怒り右', 1], ['怒り目', 0.6]],
    [['Fcl_ALL_Angry', 1]],
  ],
  sad: [
    [['困る', 1]],
    [['困る左', 1], ['困る右', 1], ['悲しむ', 0.6]],
    [['Fcl_ALL_Sorrow', 1]],
  ],
  surprised: [[['びっくり', 1]], [['Fcl_ALL_Surprised', 1]]],
}

/**
 * 口だけの形（話していないときに、動きや感情に合わせて出す）。表情の名前は mouth-<形>。
 * 標準の表情にはこういう口だけの形が無いので、どのモデルでも材料のモーフがあれば組み立てる
 */
export const MOUTH_SHAPES = ['smile', 'grin', 'frown', 'pout', 'flat', 'cat', 'pucker'] as const

/** 目を閉じて笑う形（笑う動きのときだけ出す）。まばたきとは重ねない */
export const EYES_SMILE = 'eyes-smile'
const EYES_SMILE_RECIPES: Recipe[] = [
  [['なごみ', 1]],
  [['なごみ左', 1], ['なごみ右', 1]],
  [['笑い', 1]],
  [['Fcl_EYE_Joy', 1]],
  [['eye_smile', 1]],
]
export type MouthShape = (typeof MOUTH_SHAPES)[number]

export function mouthExpressionName(shape: MouthShape): string {
  return `mouth-${shape}`
}

const MOUTH_RECIPES: Record<MouthShape, Recipe[]> = {
  // ほほえみ（口を閉じて口角を上げる）
  smile: [[['口角上げ', 1]], [['にやり', 1]], [['Fcl_MTH_Fun', 1]], [['mouth_smile', 1]]],
  // 開いた笑顔
  grin: [[['ワ', 0.85]], [['Fcl_MTH_Joy', 1]], [['にやり', 1], ['あ', 0.3]], [['mouth_smile', 1], ['mouth_a', 0.3]]],
  // への字（困る・がっかり）。MMD の「ん」はモデルによって口が少し開く形なので使わない（閉じた口のつもりが半開きに見える）
  frown: [[['口角下げ', 1]], [['∧', 1]], [['Fcl_MTH_Sorrow', 1]], [['mouth_sad', 1]]],
  // すぼめた小さな口（考え込む・少し驚く「ん？」「お」）
  pout: [[['Fcl_MTH_Small', 1]], [['口横狭め', 0.8], ['あ', 0.15]], [['お', 0.4]]],
  // きゅっと閉じた口（退屈・集中）。「ん」は使わない（上と同じ理由）
  flat: [[['Fcl_MTH_Close', 1]], [['口横広げ', 0.4]]],
  // ω の口（いたずらっぽい）
  cat: [[['ω', 1]], [['Fcl_MTH_Fun', 0.8], ['Fcl_MTH_Small', 0.4]], [['にやり', 0.8]]],
  // とがらせた口（投げキッス）
  pucker: [[['う', 0.9], ['口横狭め', 0.6]], [['口横狭め', 1]], [['Fcl_MTH_U', 1]], [['mouth_u', 1]]],
}

/** 目を細める表情。まばたきと重なると閉じすぎるので、この表情の間はまばたきを抑える */
const BLINK_BLENDING = ['happy', 'relaxed', EYES_SMILE]

function matches(key: string, name: string): boolean {
  return key === name || key.endsWith(`_${name}`) || key.endsWith(`.${name}`)
}

/**
 * 足りない標準の表情と、口だけの形（mouth-<形>）を組み立てて登録する。登録した表情の名前を返す。
 * 口だけの形は、モデルに標準の表情があっても足す（標準の表情には口だけの形が無いため）
 */
export function registerFallbackExpressions(vrm: VRM): string[] {
  const manager = vrm.expressionManager
  if (!manager) return []
  const meshes: THREE.Mesh[] = []
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh && mesh.morphTargetDictionary) meshes.push(mesh)
  })
  if (meshes.length === 0) return []
  /** そのモーフを持つメッシュと番号 */
  const find = (name: string): [THREE.Mesh, number][] => {
    const found: [THREE.Mesh, number][] = []
    for (const mesh of meshes) {
      for (const [key, index] of Object.entries(mesh.morphTargetDictionary ?? {})) {
        if (matches(key, name)) found.push([mesh, index])
      }
    }
    return found
  }
  const added: string[] = []
  const all: [string, Recipe[]][] = [
    ...Object.entries(RECIPES),
    ...MOUTH_SHAPES.map((shape): [string, Recipe[]] => [mouthExpressionName(shape), MOUTH_RECIPES[shape]]),
    [EYES_SMILE, EYES_SMILE_RECIPES],
  ]
  for (const [preset, recipes] of all) {
    if (manager.getExpression(preset)) continue
    for (const recipe of recipes) {
      const parts = recipe.map(([name, weight]) => ({ targets: find(name), weight }))
      if (parts.some((p) => p.targets.length === 0)) continue
      const expression = new VRMExpression(preset)
      for (const { targets, weight } of parts) {
        for (const [mesh, index] of targets) {
          expression.addBind(new VRMExpressionMorphTargetBind({ primitives: [mesh], index, weight }))
        }
      }
      if (BLINK_BLENDING.includes(preset)) expression.overrideBlink = 'blend'
      manager.registerExpression(expression)
      added.push(preset)
      break
    }
  }
  return added
}

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { VRMExpression, VRMExpressionManager, type VRM } from '@pixiv/three-vrm'
import { registerFallbackExpressions } from './fallbackExpressions'

/** 顔のモーフだけを持つ、表情の登録が無いモデルの代わり */
function fakeVrm(morphs: string[], existing: string[] = []): VRM {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry())
  mesh.morphTargetDictionary = Object.fromEntries(morphs.map((name, i) => [name, i]))
  mesh.morphTargetInfluences = morphs.map(() => 0)
  const scene = new THREE.Group()
  scene.add(mesh)
  const manager = new VRMExpressionManager()
  for (const name of existing) manager.registerExpression(new VRMExpression(name))
  return { scene, expressionManager: manager } as unknown as VRM
}

describe('registerFallbackExpressions（表情の登録が無いモデル）', () => {
  it('MMD 式の顔のモーフから、まばたき・口形・感情を組み立てる', () => {
    const vrm = fakeVrm(['ウィンク', 'ウィンク右', 'あ', 'い', 'え', 'ω', '口横狭め', 'にこり左', 'にこり右', 'なごみ左', 'なごみ右', '困る左', '困る右', '悲しむ', 'びっくり'])
    const added = registerFallbackExpressions(vrm)
    expect(added).toEqual(expect.arrayContaining(['blink', 'aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'relaxed', 'sad', 'surprised']))
    // 左右のウィンクを合わせて、両目を閉じる
    expect(vrm.expressionManager!.getExpression('blink')!.binds).toHaveLength(2)
  })

  it('動かすと、材料のモーフが動く', () => {
    const vrm = fakeVrm(['まばたき', 'あ'])
    registerFallbackExpressions(vrm)
    vrm.expressionManager!.setValue('aa', 1)
    vrm.expressionManager!.update()
    const mesh = vrm.scene.children[0] as THREE.Mesh
    expect(mesh.morphTargetInfluences![1]).toBeCloseTo(1)
  })

  it('モデルにすでにある表情には手を付けず、材料が無い表情は作らない', () => {
    const vrm = fakeVrm(['まばたき', 'あ'], ['blink'])
    expect(registerFallbackExpressions(vrm)).toEqual(['aa'])
  })
})

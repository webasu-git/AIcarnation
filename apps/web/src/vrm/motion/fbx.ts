import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import type { VRMHumanBoneName } from '@pixiv/three-vrm'
import { VRMAnimation } from '@pixiv/three-vrm-animation'

/**
 * Mixamo などの FBX の動きを、VRM アニメーション（.vrma を読んだときと同じ形）に読み替える。
 * 読み替えたあとは .vrma と同じ道を通るので、どのモデルにも同じように当てられる。
 * ボーン名は Mixamo の名前（mixamorig:Hips など）で照らし合わせる。「mixamorig1:」のような番号付きや、
 * 頭の「mixamorig:」が無い名前も受け付ける。基本の姿勢は T ポーズ（Mixamo の書き出しはそうなっている）とみなす
 */

/** Mixamo のボーン名（頭の mixamorig: を除いたもの）→ VRM のボーン名 */
const MIXAMO_BONES: Record<string, VRMHumanBoneName> = {
  Hips: 'hips',
  Spine: 'spine',
  Spine1: 'chest',
  Spine2: 'upperChest',
  Neck: 'neck',
  Head: 'head',
  LeftShoulder: 'leftShoulder',
  LeftArm: 'leftUpperArm',
  LeftForeArm: 'leftLowerArm',
  LeftHand: 'leftHand',
  LeftHandThumb1: 'leftThumbMetacarpal',
  LeftHandThumb2: 'leftThumbProximal',
  LeftHandThumb3: 'leftThumbDistal',
  LeftHandIndex1: 'leftIndexProximal',
  LeftHandIndex2: 'leftIndexIntermediate',
  LeftHandIndex3: 'leftIndexDistal',
  LeftHandMiddle1: 'leftMiddleProximal',
  LeftHandMiddle2: 'leftMiddleIntermediate',
  LeftHandMiddle3: 'leftMiddleDistal',
  LeftHandRing1: 'leftRingProximal',
  LeftHandRing2: 'leftRingIntermediate',
  LeftHandRing3: 'leftRingDistal',
  LeftHandPinky1: 'leftLittleProximal',
  LeftHandPinky2: 'leftLittleIntermediate',
  LeftHandPinky3: 'leftLittleDistal',
  RightShoulder: 'rightShoulder',
  RightArm: 'rightUpperArm',
  RightForeArm: 'rightLowerArm',
  RightHand: 'rightHand',
  RightHandThumb1: 'rightThumbMetacarpal',
  RightHandThumb2: 'rightThumbProximal',
  RightHandThumb3: 'rightThumbDistal',
  RightHandIndex1: 'rightIndexProximal',
  RightHandIndex2: 'rightIndexIntermediate',
  RightHandIndex3: 'rightIndexDistal',
  RightHandMiddle1: 'rightMiddleProximal',
  RightHandMiddle2: 'rightMiddleIntermediate',
  RightHandMiddle3: 'rightMiddleDistal',
  RightHandRing1: 'rightRingProximal',
  RightHandRing2: 'rightRingIntermediate',
  RightHandRing3: 'rightRingDistal',
  RightHandPinky1: 'rightLittleProximal',
  RightHandPinky2: 'rightLittleIntermediate',
  RightHandPinky3: 'rightLittleDistal',
  LeftUpLeg: 'leftUpperLeg',
  LeftLeg: 'leftLowerLeg',
  LeftFoot: 'leftFoot',
  LeftToeBase: 'leftToes',
  RightUpLeg: 'rightUpperLeg',
  RightLeg: 'rightLowerLeg',
  RightFoot: 'rightFoot',
  RightToeBase: 'rightToes',
}

/** 読み込んだ FBX のノード名から VRM のボーン名を引く（three.js は名前の「:」を取り除いて持つ） */
function vrmBoneOf(nodeName: string): VRMHumanBoneName | undefined {
  return MIXAMO_BONES[nodeName.replace(/^mixamorig\d*:?/, '')]
}

export { isFbx } from './fbxSignature'

/** FBX のデータを読み、VRM アニメーションにする。体のボーンの動きが1つも無ければ例外 */
export function parseFbxMotion(data: ArrayBuffer): VRMAnimation {
  const root = new FBXLoader().parse(data, '')
  const clips = root.animations
  // Mixamo の書き出しは「mixamo.com」という名前の1本。無ければいちばん長いものを使う
  const clip =
    THREE.AnimationClip.findByName(clips, 'mixamo.com') ?? [...clips].sort((a, b) => b.duration - a.duration)[0]
  if (!clip) throw new Error('FBX に動きが入っていません')
  return animationFromRig(root, clip)
}

/**
 * 骨格（基本の姿勢で置いたもの）と、その骨格を動かすクリップから、VRM アニメーションを作る。
 * 各ボーンの回転を「基本の姿勢からの回り方」に直す：親の基本の向き × 動きの回転 × 自分の基本の向きの逆。
 * これは .vrma を読むとき（@pixiv/three-vrm-animation）と同じ直し方で、ボーンの向きの付け方が違う骨格でも同じ結果になる
 */
export function animationFromRig(root: THREE.Object3D, clip: THREE.AnimationClip): VRMAnimation {
  root.updateMatrixWorld(true)
  const animation = new VRMAnimation()
  animation.duration = clip.duration
  const parentRest = new THREE.Quaternion()
  const restInverse = new THREE.Quaternion()
  const q = new THREE.Quaternion()
  const v = new THREE.Vector3()
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.')
    const nodeName = track.name.slice(0, dot)
    const property = track.name.slice(dot + 1)
    const bone = vrmBoneOf(nodeName)
    const node = bone ? root.getObjectByName(nodeName) : undefined
    if (!bone || !node) continue
    if (property === 'quaternion' && !animation.humanoidTracks.rotation.has(bone)) {
      node.getWorldQuaternion(restInverse).invert()
      if (node.parent) node.parent.getWorldQuaternion(parentRest)
      else parentRest.identity()
      const values = new Float32Array(track.values.length)
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(track.values, i).premultiply(parentRest).multiply(restInverse).toArray(values, i)
      }
      animation.humanoidTracks.rotation.set(bone, new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, track.times, values))
    } else if (property === 'position' && bone === 'hips' && !animation.humanoidTracks.translation.has('hips')) {
      // 腰の位置は、親の座標（拡大縮小・向きを含む）から世界の座標に直す。単位の違いは、基本の腰の高さとの比で吸収される
      const parentMatrix = node.parent?.matrixWorld ?? new THREE.Matrix4()
      const values = new Float32Array(track.values.length)
      for (let i = 0; i < values.length; i += 3) v.fromArray(track.values, i).applyMatrix4(parentMatrix).toArray(values, i)
      animation.humanoidTracks.translation.set('hips', new THREE.VectorKeyframeTrack('hips.position', track.times, values))
      node.getWorldPosition(animation.restHipsPosition)
    }
  }
  if (animation.humanoidTracks.rotation.size === 0) {
    throw new Error('FBX の動きに、Mixamo の骨格（mixamorig:Hips など）のボーンが見つかりません')
  }
  // 腰の基本の高さが分からないと位置の比が出せないので、位置の動きは使わない
  if (animation.restHipsPosition.y < 1e-3) animation.humanoidTracks.translation.clear()
  return animation
}

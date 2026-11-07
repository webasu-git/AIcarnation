import * as THREE from 'three'

/**
 * 試験用の小さな FBX（テキスト版）を組み立てる。テストでだけ使う。
 * Mixamo の書き出しに似せて、次のようにする：
 * - 単位は cm で、いちばん上の Armature を 0.01 倍にして m にする
 * - ボーンごとに PreRotation で基本の向きを付ける（ボーンの向きの付け方が VRM と違う骨格を試すため）
 * - 位置は T ポーズ（腰の高さ 0.9m、腕は横に伸ばす）
 * 動き：腰が 0.1m 上がり、背骨が x 軸まわりに、左の上腕が z 軸まわりに回る（どれも VRM の正規化した向きで指定する）
 */

type Bone = { name: string; parent: string | null; world: [number, number, number]; pre: [number, number, number] }

const BONES: Bone[] = [
  { name: 'Hips', parent: null, world: [0, 0.9, 0], pre: [-90, 0, 0] },
  { name: 'Spine', parent: 'Hips', world: [0, 1.0, 0], pre: [10, 20, -5] },
  { name: 'LeftArm', parent: 'Spine', world: [0.15, 1.3, 0], pre: [0, 0, -90] },
  { name: 'LeftForeArm', parent: 'LeftArm', world: [0.4, 1.3, 0], pre: [30, 0, 15] },
]

/** 動き（終わりの時点の、VRM の正規化した回転）。始めは回転なし */
export const FIXTURE_MOTION = {
  duration: 1,
  hipsLift: 0.1,
  spine: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2),
  leftUpperArm: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -1.0),
}

const KTIME_PER_SECOND = 46186158000
const SCALE = 0.01

function preQuat(b: Bone): THREE.Quaternion {
  const [x, y, z] = b.pre.map(THREE.MathUtils.degToRad) as [number, number, number]
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'ZYX'))
}

/** 基本の姿勢での、各ボーンの世界の向き（Armature の拡大縮小は向きに効かない） */
function restWorldQuats(): Map<string, THREE.Quaternion> {
  const map = new Map<string, THREE.Quaternion>()
  for (const b of BONES) {
    const parent = b.parent ? map.get(b.parent)! : new THREE.Quaternion()
    map.set(b.name, parent.clone().multiply(preQuat(b)))
  }
  return map
}

/** ボーン名の頭に付ける文字（Mixamo は "mixamorig:"。番号付きや無しも試す） */
export function makeTestFbx(prefix = 'mixamorig:'): ArrayBuffer {
  const rest = restWorldQuats()
  const byName = new Map(BONES.map((b) => [b.name, b]))
  const id = (i: number) => 1000 + i
  const lines: string[] = []
  const conns: string[] = []
  const p = (...xs: number[]) => xs.map((x) => (Math.abs(x) < 1e-12 ? 0 : x)).join(',')

  // Armature（拡大縮小だけ）
  lines.push(`\tModel: 999, "Model::Armature", "Null" {`, `\t\tProperties70:  {`, `\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",${p(SCALE, SCALE, SCALE)}`, `\t\t}`, `\t}`)
  conns.push(`\tC: "OO",999,0`)

  BONES.forEach((b, i) => {
    // 親の座標での位置（cm）：親の世界の向きの逆で回し、拡大縮小を戻す
    const parent = b.parent ? byName.get(b.parent)! : null
    const offset = new THREE.Vector3(...b.world).sub(new THREE.Vector3(...(parent ? parent.world : [0, 0, 0])))
    if (parent) offset.applyQuaternion(rest.get(parent.name)!.clone().invert())
    offset.divideScalar(SCALE)
    lines.push(
      `\tModel: ${id(i)}, "Model::${prefix}${b.name}", "LimbNode" {`,
      `\t\tProperties70:  {`,
      `\t\t\tP: "PreRotation", "Vector3D", "Vector", "",${p(...b.pre)}`,
      `\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",${p(offset.x, offset.y, offset.z)}`,
      `\t\t}`,
      `\t}`,
    )
    conns.push(`\tC: "OO",${id(i)},${parent ? id(BONES.indexOf(parent)) : 999}`)
  })

  // 動き
  const stop = FIXTURE_MOTION.duration * KTIME_PER_SECOND
  lines.push(
    `\tAnimationStack: 2000, "AnimStack::mixamo.com", "" {`,
    `\t\tProperties70:  {`,
    `\t\t\tP: "LocalStop", "KTime", "Time", "",${stop}`,
    `\t\t}`,
    `\t}`,
    `\tAnimationLayer: 2001, "AnimLayer::BaseLayer", "" {`,
    `\t}`,
  )
  conns.push(`\tC: "OO",2001,2000`)
  let nextId = 3000
  const curve = (values: [number, number]) => {
    const cid = nextId++
    lines.push(
      `\tAnimationCurve: ${cid}, "AnimCurve::", "" {`,
      `\t\tDefault: ${values[0]}`,
      `\t\tKeyVer: 4008`,
      `\t\tKeyTime: *2 {`,
      `\t\t\ta: 0,${stop}`,
      `\t\t}`,
      `\t\tKeyValueFloat: *2 {`,
      `\t\t\ta: ${p(...values)}`,
      `\t\t}`,
      `\t}`,
    )
    return cid
  }
  const curveNode = (bone: number, attr: 'T' | 'R', start: THREE.Vector3, end: THREE.Vector3) => {
    const nid = nextId++
    lines.push(
      `\tAnimationCurveNode: ${nid}, "AnimCurveNode::${attr}", "" {`,
      `\t\tProperties70:  {`,
      `\t\t\tP: "d|X", "Number", "", "A",${p(start.x)}`,
      `\t\t\tP: "d|Y", "Number", "", "A",${p(start.y)}`,
      `\t\t\tP: "d|Z", "Number", "", "A",${p(start.z)}`,
      `\t\t}`,
      `\t}`,
    )
    conns.push(`\tC: "OO",${nid},2001`, `\tC: "OP",${nid},${id(bone)}, "${attr === 'T' ? 'Lcl Translation' : 'Lcl Rotation'}"`)
    for (const axis of ['X', 'Y', 'Z'] as const) {
      const k = axis.toLowerCase() as 'x' | 'y' | 'z'
      conns.push(`\tC: "OP",${curve([start[k], end[k]])},${nid}, "d|${axis}"`)
    }
  }

  // 正規化した回転 N を、FBX の Lcl Rotation（度、ZYX）に直す：ローカル = 親の基本の向きの逆 × N × 自分の基本の向き、それを PreRotation の逆で割る
  const lclRotation = (b: Bone, n: THREE.Quaternion) => {
    const parentRest = b.parent ? rest.get(b.parent)! : new THREE.Quaternion()
    const local = parentRest.clone().invert().multiply(n).multiply(rest.get(b.name)!)
    const lcl = preQuat(b).invert().multiply(local)
    const e = new THREE.Euler().setFromQuaternion(lcl, 'ZYX')
    return new THREE.Vector3(...[e.x, e.y, e.z].map(THREE.MathUtils.radToDeg))
  }
  const hips = 0
  const hipsStart = new THREE.Vector3(...BONES[hips]!.world).divideScalar(SCALE)
  curveNode(hips, 'T', hipsStart, hipsStart.clone().add(new THREE.Vector3(0, FIXTURE_MOTION.hipsLift / SCALE, 0)))
  const spine = BONES[1]!
  curveNode(1, 'R', lclRotation(spine, new THREE.Quaternion()), lclRotation(spine, FIXTURE_MOTION.spine))
  const arm = BONES[2]!
  curveNode(2, 'R', lclRotation(arm, new THREE.Quaternion()), lclRotation(arm, FIXTURE_MOTION.leftUpperArm))

  const text = [
    '; FBX 7.4.0 project file',
    'FBXHeaderExtension:  {',
    '\tFBXHeaderVersion: 1003',
    '\tFBXVersion: 7400',
    '}',
    'Objects:  {',
    ...lines,
    '}',
    'Connections:  {',
    ...conns,
    '}',
    '',
  ].join('\n')
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

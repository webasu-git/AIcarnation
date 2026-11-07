/**
 * 試験用の小さな VRM アニメーション（.vrma、glb 形式）を組み立てる。テストと動作確認でだけ使う。
 * - idle：腕を下ろして、背骨がゆっくり前後に揺れるループ（2 秒）
 * - wave：右手を上げて振る（2 秒）
 * ボーンは T ポーズ（回転なし）で並べ、回転は VRM 1.0 の向きで書く
 */

type BoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'leftHand'
  | 'rightUpperArm'
  | 'rightLowerArm'
  | 'rightHand'

const BONES: { name: BoneName; parent: number | null; t: [number, number, number] }[] = [
  { name: 'hips', parent: null, t: [0, 0.9, 0] },
  { name: 'spine', parent: 0, t: [0, 0.1, 0] },
  { name: 'chest', parent: 1, t: [0, 0.15, 0] },
  { name: 'neck', parent: 2, t: [0, 0.2, 0] },
  { name: 'head', parent: 3, t: [0, 0.08, 0] },
  { name: 'leftUpperArm', parent: 2, t: [0.15, 0.15, 0] },
  { name: 'leftLowerArm', parent: 5, t: [0.25, 0, 0] },
  { name: 'leftHand', parent: 6, t: [0.22, 0, 0] },
  { name: 'rightUpperArm', parent: 2, t: [-0.15, 0.15, 0] },
  { name: 'rightLowerArm', parent: 8, t: [-0.25, 0, 0] },
  { name: 'rightHand', parent: 9, t: [-0.22, 0, 0] },
]

/** 軸まわりの回転の四元数（x, y, z, w） */
function axisAngle(axis: 'x' | 'y' | 'z', angle: number): [number, number, number, number] {
  const s = Math.sin(angle / 2)
  const c = Math.cos(angle / 2)
  return axis === 'x' ? [s, 0, 0, c] : axis === 'y' ? [0, s, 0, c] : [0, 0, s, c]
}

type Track = { bone: BoneName; times: number[]; values: [number, number, number, number][] }

function tracksFor(kind: 'idle' | 'wave'): Track[] {
  const times = [0, 0.5, 1, 1.5, 2]
  // 腕を下ろす（左腕は +x を向いているので z を負、右腕は z を正に回すと下がる）
  const leftDown = times.map(() => axisAngle('z', -1.2))
  if (kind === 'idle') {
    return [
      { bone: 'leftUpperArm', times, values: leftDown },
      { bone: 'rightUpperArm', times, values: times.map(() => axisAngle('z', 1.2)) },
      { bone: 'spine', times, values: times.map((t) => axisAngle('x', Math.sin((t / 2) * Math.PI * 2) * 0.05)) },
    ]
  }
  return [
    { bone: 'leftUpperArm', times, values: leftDown },
    // 右腕を上げて（z を負）、前腕を左右に振る
    { bone: 'rightUpperArm', times, values: times.map(() => axisAngle('z', -1.0)) },
    { bone: 'rightLowerArm', times, values: times.map((_, i) => axisAngle('z', i % 2 === 0 ? -0.2 : -0.8)) },
  ]
}

/** .vrma（glb）のデータを作る */
export function makeTestVrma(kind: 'idle' | 'wave'): ArrayBuffer {
  const tracks = tracksFor(kind)
  // バイナリ：各トラックの時刻（float）と回転（vec4）を並べる
  const floats: number[] = []
  const accessors: object[] = []
  const bufferViews: object[] = []
  const samplers: object[] = []
  const channels: object[] = []
  for (const track of tracks) {
    const timeOffset = floats.length * 4
    floats.push(...track.times)
    bufferViews.push({ buffer: 0, byteOffset: timeOffset, byteLength: track.times.length * 4 })
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: track.times.length,
      type: 'SCALAR',
      min: [Math.min(...track.times)],
      max: [Math.max(...track.times)],
    })
    const timeAccessor = accessors.length - 1
    const valueOffset = floats.length * 4
    for (const v of track.values) floats.push(...v)
    bufferViews.push({ buffer: 0, byteOffset: valueOffset, byteLength: track.values.length * 16 })
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: track.values.length, type: 'VEC4' })
    samplers.push({ input: timeAccessor, output: accessors.length - 1, interpolation: 'LINEAR' })
    channels.push({ sampler: samplers.length - 1, target: { node: BONES.findIndex((b) => b.name === track.bone), path: 'rotation' } })
  }
  const bin = new Float32Array(floats)
  const nodes = BONES.map((b, i) => ({
    name: b.name,
    translation: b.t,
    children: BONES.map((c, j) => (c.parent === i ? j : -1)).filter((j) => j >= 0),
  })).map((n) => (n.children.length ? n : { name: n.name, translation: n.translation }))
  const json = {
    asset: { version: '2.0', generator: 'aicarnation test' },
    extensionsUsed: ['VRMC_vrm_animation'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews,
    accessors,
    animations: [{ name: kind, samplers, channels }],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones: Object.fromEntries(BONES.map((b, i) => [b.name, { node: i }])) },
      },
    },
  }
  // glb：ヘッダー（12 バイト）＋ JSON チャンク ＋ BIN チャンク（どちらも 4 バイト境界にそろえる）
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = Math.ceil(jsonBytes.length / 4) * 4
  const binLength = Math.ceil(bin.byteLength / 4) * 4
  const total = 12 + 8 + jsonLength + 8 + binLength
  const out = new ArrayBuffer(total)
  const view = new DataView(out)
  const bytes = new Uint8Array(out)
  view.setUint32(0, 0x46546c67, true) // 'glTF'
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true) // 'JSON'
  bytes.fill(0x20, 20, 20 + jsonLength)
  bytes.set(jsonBytes, 20)
  const binStart = 20 + jsonLength
  view.setUint32(binStart, binLength, true)
  view.setUint32(binStart + 4, 0x004e4942, true) // 'BIN'
  bytes.set(new Uint8Array(bin.buffer), binStart + 8)
  return out
}

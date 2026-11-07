import * as THREE from 'three'

/**
 * 動きのファイルを「その場にとどめる」。
 * 動きのファイルには、横に踏み出す・身を乗り出す・体ごと横を向くといった大きな動きが入っていることがあり、
 * そのまま流すとアバターが画面の端へ寄ったり、横を向いたままになったりする。
 * 小さな揺れ（重心の乗せ替えなど）はそのまま残し、大きくなるほど強く抑える（柔らかい上限）。
 * 上下の動きと前への曲げ（おじぎ・かがむ）は抑えない
 */

/** 腰の前後左右の動きの上限（基本の腰の高さに対する割合） */
export const MAX_HIPS_TRAVEL = 0.06
/** 体の向き（腰の縦軸まわりの回転）の上限（ラジアン） */
export const MAX_HIPS_YAW = 0.45
/** 腰・背骨それぞれの、横への傾きの上限（ラジアン）。耳打ちのように大きく横へ傾くと、頭が画面の端へ寄るため */
export const MAX_SIDE_LEAN = 0.15

/** 大きさ x を、上限 limit に柔らかく近づける（小さいうちはほぼそのまま） */
export function softLimit(x: number, limit: number): number {
  return limit * Math.tanh(x / limit)
}

/**
 * 腰の位置（x, y, z の並び）を、基本の位置 rest のまわりで前後左右だけ抑える。
 * limit は動いてよい距離の目安（同じ単位）
 */
export function limitHipsTravel(values: ArrayLike<number> & { [i: number]: number }, rest: THREE.Vector3, limit: number): void {
  for (let i = 0; i + 2 < values.length; i += 3) {
    const dx = (values[i] ?? 0) - rest.x
    const dz = (values[i + 2] ?? 0) - rest.z
    const d = Math.hypot(dx, dz)
    if (d < 1e-9) continue
    const k = softLimit(d, limit) / d
    values[i] = rest.x + dx * k
    values[i + 2] = rest.z + dz * k
  }
}

const Y = new THREE.Vector3(0, 1, 0)
const euler = new THREE.Euler()
const q = new THREE.Quaternion()
const twist = new THREE.Quaternion()
const swing = new THREE.Quaternion()

/**
 * 腰の回転（x, y, z, w の並び）のうち、縦軸まわりの回り（体の向き）だけを抑える。
 * 回転を「縦軸まわりのひねり」と「それ以外の傾き」に分け、ひねりの角度だけを柔らかく上限に近づけてから戻す
 */
export function limitHipsYaw(values: ArrayLike<number> & { [i: number]: number }, limit: number): void {
  for (let i = 0; i + 3 < values.length; i += 4) {
    q.set(values[i] ?? 0, values[i + 1] ?? 0, values[i + 2] ?? 0, values[i + 3] ?? 1)
    // ひねり：縦軸の成分だけを残した四元数
    twist.set(0, q.y, 0, q.w)
    if (twist.lengthSq() < 1e-12) continue
    twist.normalize()
    swing.copy(q).multiply(twist.clone().invert())
    let angle = 2 * Math.atan2(twist.y, twist.w)
    if (angle > Math.PI) angle -= 2 * Math.PI
    if (angle < -Math.PI) angle += 2 * Math.PI
    twist.setFromAxisAngle(Y, softLimit(angle, limit))
    q.copy(swing).multiply(twist)
    values[i] = q.x
    values[i + 1] = q.y
    values[i + 2] = q.z
    values[i + 3] = q.w
  }
}

/**
 * 回転（x, y, z, w の並び）のうち、横への傾き（前を向いたときの、奥行きの軸まわりの回転）だけを抑える。
 * 向き・前後の曲げ・横の傾きに分けて（YXZ の順）、横の傾きだけを柔らかく上限に近づけてから戻す
 */
export function limitSideLean(values: ArrayLike<number> & { [i: number]: number }, limit: number): void {
  for (let i = 0; i + 3 < values.length; i += 4) {
    q.set(values[i] ?? 0, values[i + 1] ?? 0, values[i + 2] ?? 0, values[i + 3] ?? 1)
    euler.setFromQuaternion(q, 'YXZ')
    euler.z = softLimit(euler.z, limit)
    q.setFromEuler(euler)
    values[i] = q.x
    values[i + 1] = q.y
    values[i + 2] = q.z
    values[i + 3] = q.w
  }
}

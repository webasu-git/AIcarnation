import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMHumanBoneParentMap, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, type VRMAnimation } from '@pixiv/three-vrm-animation'
import type { MotionState } from '../idle'
import { isFbx } from './fbxSignature'
import { faceForMotion, type MotionFace } from './faces'
import { MAX_HIPS_TRAVEL, MAX_HIPS_YAW, MAX_SIDE_LEAN, limitHipsTravel, limitHipsYaw, limitSideLean } from './inPlace'

/**
 * 動きのファイル（VRM アニメーション .vrma）を再生する。
 * 体の土台の動きは人が作った動きに任せ、コードの動き（視線・IK・感情の味付け・ばね）はその上に足す。
 * 表情・視線・口パクはアプリの仕組みで動かすので、動きのファイルからは体のボーンの動きだけを使う。
 */

/** 動きの役 */
export const MOTION_ROLES = ['idle', 'thinking', 'working', 'talking', 'greet', 'joy', 'play'] as const
export type MotionRole = (typeof MOTION_ROLES)[number]

/** ずっと繰り返す役（会話の様子ごと） */
const LOOP_ROLES: readonly MotionRole[] = ['idle', 'thinking', 'working', 'talking']

/** 会話の様子ごとに使うループ。無ければ待機のループを使う */
const LOOP_BY_STATE: Record<MotionState, MotionRole> = {
  idle: 'idle',
  listening: 'idle',
  thinking: 'thinking',
  working: 'working',
  speaking: 'talking',
}

/** ループどうしを切り替える時間（秒） */
const LOOP_FADE = 0.6
/** ループが最初に戻るとき、終わりの姿勢から始めの姿勢へ移す時間（秒） */
const SEAM_BLEND = 0.5
/** 1回きりの動きの入り・抜けの時間（秒） */
const GESTURE_FADE_IN = 0.3
const GESTURE_FADE_OUT = 0.5

/** 動きのファイルを読む。.vrma（glb）と FBX（Mixamo の骨格）を中身で見分ける。どちらとしても読めなければ例外 */
export async function parseMotion(data: ArrayBuffer): Promise<VRMAnimation> {
  if (!isFbx(data)) return parseVrma(data)
  // FBX の読み込み部品は大きいので、FBX を読むときだけ取り込む
  const { parseFbxMotion } = await import('./fbx')
  return parseFbxMotion(data)
}

/** .vrma のデータを読む。VRM アニメーションでなければ例外 */
export async function parseVrma(data: ArrayBuffer): Promise<VRMAnimation> {
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
  const gltf = await loader.parseAsync(data, '')
  const animation = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0]
  if (!animation) throw new Error('VRM アニメーション（.vrma）ではありません')
  return animation
}

/**
 * 体のボーンの動きだけのクリップを作る（表情・視線の動きは入れない）。
 * 腰の前後左右の位置は、動きの始めがモデルの基本の位置になるようにずらす。
 * 動きのファイルには、撮ったときの立ち位置（中心から横にずれているなど）がそのまま入っているため。
 * そのうえで「その場にとどめる」：大きく踏み出す・体ごと横を向く・大きく横へ傾く動きは柔らかく抑える（inPlace.ts）
 */
function bodyClip(animation: VRMAnimation, vrm: VRM): THREE.AnimationClip {
  // createVRMAnimationClip は表情・視線があればそれも動かすので、それらを持たない形で渡す
  const bodyOnly = { humanoid: vrm.humanoid, meta: vrm.meta, scene: vrm.scene } as unknown as VRM
  const clip = createVRMAnimationClip(animation, bodyOnly)
  const hips = vrm.humanoid.getNormalizedBoneNode('hips')
  if (!hips) return clip
  // 基本の姿勢の腰の位置（いまの hips.position はコードの動きで少しずれていることがある）
  const restArray = vrm.humanoid.normalizedRestPose.hips?.position
  const rest = restArray ? new THREE.Vector3().fromArray(restArray) : hips.position.clone()
  const position = clip.tracks.find((t) => t.name === `${hips.name}.position`)
  if (position && position.values.length >= 3) {
    const values = position.values
    const dx = rest.x - (values[0] ?? 0)
    const dz = rest.z - (values[2] ?? 0)
    for (let i = 0; i + 2 < values.length; i += 3) {
      values[i] = (values[i] ?? 0) + dx
      values[i + 2] = (values[i + 2] ?? 0) + dz
    }
    limitHipsTravel(values, rest, MAX_HIPS_TRAVEL * Math.max(rest.y, 0.1))
  }
  const rotation = clip.tracks.find((t) => t.name === `${hips.name}.quaternion`)
  if (rotation) limitHipsYaw(rotation.values, MAX_HIPS_YAW)
  for (const name of ['hips', 'spine'] as const) {
    const node = vrm.humanoid.getNormalizedBoneNode(name)
    const track = node && clip.tracks.find((t) => t.name === `${node.name}.quaternion`)
    if (track) limitSideLean(track.values, MAX_SIDE_LEAN)
  }
  return clip
}

/** なめらかに 0→1 へ移る（両端でゆっくり） */
function smoothstep(t: number): number {
  const u = Math.min(1, Math.max(0, t))
  return u * u * (3 - 2 * u)
}

/** 指先が頭の近くに来たら「顔に手を当てる動き」とみなす（上腕の長さに対する割合） */
const FACE_TOUCH_REACH = 0.75
/** 顔に手を当てているかを調べる間隔（秒） */
const FACE_TOUCH_STEP = 0.1

/**
 * 動きの中で、手（指先）が顔に触れるほど頭に近づくか。あごに手を当てる・頬杖などの動き。
 * 正規化したボーンの基本の位置に、動きのファイルの回転を当てて、指先と頭の距離を測る
 */
export function touchesFace(clip: THREE.AnimationClip, vrm: VRM): boolean {
  const humanoid = vrm.humanoid
  const restPose = humanoid.normalizedRestPose
  const upper = restPose.rightLowerArm?.position ?? restPose.leftLowerArm?.position
  if (!upper || !restPose.head) return false
  const reach = new THREE.Vector3().fromArray(upper).length() * FACE_TOUCH_REACH
  const nodeToBone = new Map<string, VRMHumanBoneName>()
  for (const name of Object.keys(humanoid.humanBones) as VRMHumanBoneName[]) {
    const node = humanoid.getNormalizedBoneNode(name)
    if (node) nodeToBone.set(node.name, name)
  }
  const tracks = new Map<VRMHumanBoneName, THREE.Interpolant>()
  for (const track of clip.tracks) {
    if (!track.name.endsWith('.quaternion')) continue
    const bone = nodeToBone.get(track.name.slice(0, -'.quaternion'.length))
    if (bone) tracks.set(bone, new THREE.QuaternionLinearInterpolant(track.times, track.values, 4, new Float32Array(4)))
  }
  // 指先の代わりに、人差し指・中指の先のボーンと手首を使う（指を握っていても、伸ばした指で触れていても見つかるよう）
  const tips = (['left', 'right'] as const)
    .flatMap((side) => [`${side}IndexDistal`, `${side}MiddleDistal`, `${side}Hand`] as const)
    .filter((b) => restPose[b])
  const parentOf = (bone: VRMHumanBoneName): VRMHumanBoneName | null => {
    let p = VRMHumanBoneParentMap[bone]
    while (p && !restPose[p]) p = VRMHumanBoneParentMap[p]
    return p
  }
  const worldPos = new Map<VRMHumanBoneName, THREE.Vector3>()
  const worldRot = new Map<VRMHumanBoneName, THREE.Quaternion>()
  const local = new THREE.Quaternion()
  const place = (bone: VRMHumanBoneName, t: number): THREE.Vector3 => {
    const known = worldPos.get(bone)
    if (known) return known
    // 親を先に置く（作業用の回転を親の計算で上書きしないよう、自分の回転はそのあとで読む）
    const parent = parentOf(bone)
    const parentPos = parent ? place(parent, t) : null
    const value = tracks.get(bone)?.evaluate(t)
    if (value) local.fromArray(value as unknown as number[])
    else local.identity()
    const pos = new THREE.Vector3().fromArray(restPose[bone]?.position ?? [0, 0, 0])
    let rot = local.clone()
    if (parent && parentPos) {
      const parentRot = worldRot.get(parent) ?? new THREE.Quaternion()
      pos.applyQuaternion(parentRot).add(parentPos)
      rot = parentRot.clone().multiply(local)
    }
    worldPos.set(bone, pos)
    worldRot.set(bone, rot)
    return pos
  }
  for (let t = 0; t <= clip.duration + 1e-6; t += FACE_TOUCH_STEP) {
    worldPos.clear()
    worldRot.clear()
    const head = place('head', t)
    if (tips.some((b) => place(b, t).distanceTo(head) < reach)) return true
  }
  return false
}

/** 今、動きのファイルがボーンをどれだけ動かしているか */
export interface ClipDrive {
  /** 合計の重み（0〜1） */
  weight: number
  /** そのうち1回きりの動き（あいさつ・喜ぶなど）の重み（0〜1） */
  gestureWeight: number
  /** そのうち顔に手を当てる動き（あごに手など）の重み（0〜1） */
  faceTouchWeight: number
  /** 動かしているボーン */
  bones: Set<VRMHumanBoneName>
  /** 腰の位置も動かしているか */
  hipsPosition: boolean
  /** 動きのファイルが作ったボーンの向き（親の座標で） */
  rotation(bone: VRMHumanBoneName): THREE.Quaternion | null
  /** 動きのファイルが作った腰の位置 */
  hips: THREE.Vector3 | null
}

const NO_DRIVE: ClipDrive = { weight: 0, gestureWeight: 0, faceTouchWeight: 0, bones: new Set(), hipsPosition: false, rotation: () => null, hips: null }

/** 役に登録した動きの1つ（パターン）。役ごとに複数持ち、再生のたびに乱数で選ぶ */
interface Variant {
  id: string
  role: MotionRole
  animation: VRMAnimation
  action: THREE.AnimationAction | null
  /** ファイル名から決めた、動きに合わせる顔（無ければ顔は変えない） */
  face: MotionFace | null
  /** 顔に手を当てる動きか（モデルに当てて調べる） */
  touchesFace: boolean
}

/** 今の動きに合わせる顔と、その動きの位置・重み */
export interface FaceDrive {
  face: MotionFace
  /** 動きの中の位置（0〜1） */
  t: number
  /** 動きの重み（入り・抜けの途中は 1 未満） */
  weight: number
}

export class MotionPlayer {
  private readonly variants = new Map<MotionRole, Variant[]>()
  private vrm: VRM | null = null
  private mixer: THREE.AnimationMixer | null = null
  private state: MotionState = 'idle'
  /** 今流しているループと、1回きりの動き */
  private loop: Variant | null = null
  private gesture: Variant | null = null
  /** 役ごとに、前に選んだパターン（続けて同じものを選ばないため） */
  private readonly lastPicked = new Map<MotionRole, string>()
  /**
   * 身代わりのボーン。動きのファイルは実際のボーンではなくこちらへ再生し、
   * コードの動き（idle.ts）がこの向きを基準にして実際のボーンへ当てる。
   * three.js の AnimationMixer は前と同じ値なら書き込みを省くので、実際のボーンへ直接再生すると、
   * コードがボーンを書き換えたあとに動きが当たらなくなるため
   */
  private proxyRoot = new THREE.Object3D()
  private readonly proxies = new Map<VRMHumanBoneName, THREE.Object3D>()
  /**
   * コードの動きへ渡す、最終的なボーンの向きと腰の位置。
   * ループが最初に戻った直後（別のパターンへ移るときも）は、戻る前の姿勢から混ぜてつなぎ目を消す。
   * 身代わりのボーンを直接書き換えると AnimationMixer の書き込みの省略に引っかかるので、別に持つ
   */
  private readonly outRotation = new Map<VRMHumanBoneName, THREE.Quaternion>()
  private readonly outHips = new THREE.Vector3()
  private seam: { t: number; rotation: Map<VRMHumanBoneName, THREE.Quaternion>; hips: THREE.Vector3 } | null = null
  /** この更新でループが最初に戻った */
  private wrapped = false

  constructor(private readonly random: () => number = Math.random) {}

  /** モデルを読み替えたら呼ぶ。登録済みの動きを、新しいモデル用に作り直す */
  attach(vrm: VRM): void {
    this.mixer?.stopAllAction()
    this.vrm = vrm
    // 身代わりのボーンを、正規化したボーンと同じ名前で用意する（向きは回転なし、腰は基本の姿勢の位置）
    this.proxyRoot = new THREE.Object3D()
    this.proxies.clear()
    this.outRotation.clear()
    this.seam = null
    for (const name of Object.keys(vrm.humanoid.humanBones) as VRMHumanBoneName[]) {
      const node = vrm.humanoid.getNormalizedBoneNode(name)
      if (!node) continue
      const proxy = new THREE.Object3D()
      proxy.name = node.name
      if (name === 'hips') proxy.position.copy(node.position)
      this.proxyRoot.add(proxy)
      this.proxies.set(name, proxy)
      this.outRotation.set(name, new THREE.Quaternion())
    }
    this.outHips.copy(this.proxies.get('hips')?.position ?? new THREE.Vector3())
    this.mixer = new THREE.AnimationMixer(this.proxyRoot)
    this.mixer.addEventListener('finished', (e) => this.onFinished(e.action as THREE.AnimationAction))
    this.mixer.addEventListener('loop', (e) => {
      if (this.loop?.action === e.action) this.wrapped = true
    })
    this.loop = null
    this.gesture = null
    for (const list of this.variants.values()) for (const v of list) this.buildAction(v)
    this.updateLoop(0)
  }

  /** モデルを外したら呼ぶ。登録済みの動きは残し、次に attach したモデルで作り直す */
  detach(): void {
    this.mixer?.stopAllAction()
    this.mixer = null
    this.vrm = null
    this.loop = null
    this.gesture = null
    this.seam = null
    for (const list of this.variants.values()) for (const v of list) v.action = null
  }

  /** 役に動きのパターンを足す（同じ id があれば入れ替える）。name はファイル名（合わせる顔を決めるのに使う） */
  add(role: MotionRole, id: string, animation: VRMAnimation, name = ''): void {
    this.removeVariant(role, id)
    const v: Variant = { id, role, animation, action: null, face: faceForMotion(name), touchesFace: false }
    this.variants.set(role, [...(this.variants.get(role) ?? []), v])
    this.buildAction(v)
    this.updateLoop(LOOP_FADE)
  }

  /** 役から動きのパターンを外す */
  remove(role: MotionRole, id: string): void {
    this.removeVariant(role, id)
    this.updateLoop(LOOP_FADE)
  }

  /** 登録した動きをすべて外す（キャラクターを切り替えたとき） */
  clear(): void {
    for (const [role, list] of [...this.variants]) for (const v of [...list]) this.removeVariant(role, v.id)
    this.updateLoop(LOOP_FADE)
  }

  /** 1回きりの動きを再生している最中か */
  get isPlayingGesture(): boolean {
    return this.gesture !== null
  }

  has(role: MotionRole): boolean {
    return (this.variants.get(role)?.length ?? 0) > 0
  }

  /** 会話の様子が変わった。その様子のループへ切り替える */
  setState(state: MotionState): void {
    this.state = state
    this.updateLoop(LOOP_FADE)
  }

  /** 会話の様子に合うループが登録されているか（無ければ待機のループで代わりにする） */
  hasLoopFor(state: MotionState): boolean {
    return this.has(LOOP_BY_STATE[state])
  }

  /**
   * 1回きりの動きを再生する。パターンは乱数で選ぶ（id を渡せばそのパターン）。登録されていなければ false。
   * preview のときはループの役も1回だけ再生する（動きの確かめ用）。今のループと同じパターンなら最初から流し直す
   */
  playGesture(role: MotionRole, preview = false, id?: string): boolean {
    if (LOOP_ROLES.includes(role) && !preview) return false
    const list = this.variants.get(role) ?? []
    const v = id !== undefined ? list.find((x) => x.id === id) : this.pick(role)
    const action = v?.action
    if (!v || !action) return false
    if (v === this.loop) {
      // 今のループと同じパターンは、1回きりの動きを止めてループを最初から流し直す（同じ動きを入れて抜くと消えてしまうため）
      this.gesture?.action?.fadeOut(GESTURE_FADE_IN)
      this.gesture = null
      asLoop(action).reset().fadeIn(GESTURE_FADE_IN).play()
      return true
    }
    if (this.gesture && this.gesture !== v) this.gesture.action?.fadeOut(GESTURE_FADE_IN)
    this.gesture = v
    action.reset()
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.fadeIn(GESTURE_FADE_IN).play()
    this.loop?.action?.fadeOut(GESTURE_FADE_IN)
    return true
  }

  update(delta: number): void {
    if (!this.mixer) return
    this.wrapped = false
    this.mixer.update(delta)
    // 1回きりの動きが「終わった」の合図なしに止まっていたら（途中で抜かれたなど）、ループへ戻す
    const gesture = this.gesture?.action
    if (gesture && !(gesture.isScheduled() && gesture.enabled)) this.onFinished(gesture)
    if (this.wrapped) {
      // ループが最初に戻ったら、戻る直前の姿勢（前のフレームで渡したもの）から混ぜ始める
      this.seam = {
        t: 0,
        rotation: new Map([...this.outRotation].map(([bone, q]) => [bone, q.clone()])),
        hips: this.outHips.clone(),
      }
      // パターンが複数あれば、次の回は別のパターンにする
      const role = this.loop?.role
      if (role && !this.gesture && (this.variants.get(role)?.length ?? 0) > 1) this.startLoop(this.pick(role), LOOP_FADE)
    } else if (this.seam) {
      this.seam.t += delta
      if (this.seam.t >= SEAM_BLEND) this.seam = null
    }
    const a = this.seam ? smoothstep(this.seam.t / SEAM_BLEND) : 1
    for (const [bone, proxy] of this.proxies) {
      const out = this.outRotation.get(bone)
      if (!out) continue
      const from = this.seam?.rotation.get(bone)
      if (from) out.slerpQuaternions(from, proxy.quaternion, a)
      else out.copy(proxy.quaternion)
    }
    const hips = this.proxies.get('hips')
    if (hips) {
      if (this.seam) this.outHips.lerpVectors(this.seam.hips, hips.position, a)
      else this.outHips.copy(hips.position)
    }
  }

  /** 今の動きに合わせる顔。1回きりの動きの最中はその動き、それ以外はループの動き */
  get face(): FaceDrive | null {
    const v = this.gesture ?? this.loop
    const action = v?.action
    if (!v?.face || !action || !action.isScheduled() || !action.enabled) return null
    const duration = action.getClip().duration
    return { face: v.face, t: duration > 0 ? (action.time % duration) / duration : 0, weight: action.getEffectiveWeight() }
  }

  /** 今の再生の重みと、動かしているボーン */
  get drive(): ClipDrive {
    if (!this.mixer) return NO_DRIVE
    let weight = 0
    let gestureWeight = 0
    let faceTouchWeight = 0
    const bones = new Set<VRMHumanBoneName>()
    let hipsPosition = false
    for (const list of this.variants.values()) {
      for (const v of list) {
        const action = v.action
        // 止めた動きは、最後の重みが残っていても数えない
        if (!action || !action.isScheduled() || !action.enabled) continue
        const w = action.getEffectiveWeight()
        if (w <= 0.001) continue
        weight += w
        if (v === this.gesture || !LOOP_ROLES.includes(v.role)) gestureWeight += w
        if (v.touchesFace) faceTouchWeight += w
        for (const bone of v.animation.humanoidTracks.rotation.keys()) bones.add(bone)
        if (v.animation.humanoidTracks.translation.size > 0) hipsPosition = true
      }
    }
    const outRotation = this.outRotation
    const outHips = this.outHips
    return {
      weight: Math.min(1, weight),
      gestureWeight: Math.min(1, gestureWeight),
      faceTouchWeight: Math.min(1, faceTouchWeight),
      bones,
      hipsPosition,
      rotation: (bone) => outRotation.get(bone) ?? null,
      hips: this.proxies.has('hips') ? outHips : null,
    }
  }

  /** 役のパターンを乱数で選ぶ。2つ以上あれば、前と同じものは避ける */
  private pick(role: MotionRole): Variant | null {
    const list = this.variants.get(role) ?? []
    if (list.length === 0) return null
    const last = this.lastPicked.get(role)
    const choices = list.length > 1 ? list.filter((v) => v.id !== last) : list
    const v = choices[Math.floor(this.random() * choices.length)] ?? list[0] ?? null
    if (v) this.lastPicked.set(role, v.id)
    return v
  }

  private removeVariant(role: MotionRole, id: string): void {
    const list = this.variants.get(role)
    const v = list?.find((x) => x.id === id)
    if (!list || !v) return
    if (v.action) {
      v.action.stop()
      this.mixer?.uncacheAction(v.action.getClip())
    }
    if (this.loop === v) this.loop = null
    if (this.gesture === v) this.gesture = null
    this.variants.set(
      role,
      list.filter((x) => x !== v),
    )
  }

  private buildAction(v: Variant): void {
    if (!this.vrm || !this.mixer) return
    const clip = bodyClip(v.animation, this.vrm)
    v.action = this.mixer.clipAction(clip)
    v.touchesFace = touchesFace(clip, this.vrm)
    if (LOOP_ROLES.includes(v.role)) asLoop(v.action)
  }

  /** 会話の様子に合うループ（無ければ待機）へ切り替える。1回きりの動きの最中は、終わってから切り替える */
  private updateLoop(fade: number): void {
    const wanted = this.has(LOOP_BY_STATE[this.state]) ? LOOP_BY_STATE[this.state] : this.has('idle') ? 'idle' : null
    if (this.loop && wanted === this.loop.role) return
    if (!this.loop && wanted === null) return
    this.startLoop(wanted ? this.pick(wanted) : null, fade)
  }

  /** ループを、このパターンへ切り替える。1回きりの動きの最中は、終わってから流し始める */
  private startLoop(next: Variant | null, fade: number): void {
    const prev = this.loop
    this.loop = next
    if (prev && prev !== next) prev.action?.fadeOut(fade)
    if (this.gesture || !next?.action) return
    asLoop(next.action).reset().setEffectiveWeight(1)
    next.action.fadeIn(fade).play()
  }

  /** 1回きりの動きが終わったら、ループへ戻す */
  private onFinished(action: THREE.AnimationAction): void {
    if (!this.gesture || this.gesture.action !== action) return
    this.gesture = null
    action.fadeOut(GESTURE_FADE_OUT)
    const loop = this.loop?.action
    if (loop) asLoop(loop).reset().fadeIn(GESTURE_FADE_OUT).play()
  }
}

/** ループとして繰り返す設定に戻す（確かめ用に1回だけ再生したあとでも） */
function asLoop(action: THREE.AnimationAction): THREE.AnimationAction {
  action.setLoop(THREE.LoopRepeat, Infinity)
  action.clampWhenFinished = false
  return action
}

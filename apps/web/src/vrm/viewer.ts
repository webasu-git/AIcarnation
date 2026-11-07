import * as THREE from 'three'
import { StageBackground, type BackdropView } from './background'
import { GroundShadow } from './groundShadow'
import { StageLighting } from './stageLighting'
import type { Emotion } from '@aicarnation/shared'
import { disposeVrm, loadVrm, vrmSpecLabel, type VRM } from './loader'
import { IdleMotion, type Gesture, type IdleMood, type MotionState } from './idle'
import { ExpressionController, type Viseme } from './expression'
import type { SpeechCue } from './motion/expressive'
import { MotionPlayer, parseMotion, type MotionRole } from './motion/clips'
import { evaluateFace } from './motion/faces'
import { registerFallbackExpressions } from './fallbackExpressions'

const CAMERA_FOV = 30
/** 上半身が収まる距離（m）。ズームはこれに倍率を掛ける */
/** 動きに合わせる顔が無いとき */
const NO_FACE = { strength: 0, eyeClose: 0, eyeSmile: 0, mouthOpen: 0, mouths: {} }
const BASE_DISTANCE = 1.9
/** 右ドラッグでカメラを回す速さ（ラジアン／ピクセル）と、上下の限界 */
const ORBIT_SPEED = 0.008
const ORBIT_PITCH_MIN = -0.5
const ORBIT_PITCH_MAX = 1.0
/** ホイールボタンのドラッグでカメラを平行に動かせる範囲（注視点が最初の位置からどれだけ離れてよいか。m） */
const PAN_LIMIT = 1.5
const ZOOM_MIN = 0.4
const ZOOM_MAX = 2.5

/**
 * 描画の合図をどこから取るか。
 * - raf: canvas が属するウィンドウの requestAnimationFrame（本体タブ・小窓）
 * - worker: Worker のタイマー（動画PiP中。本体タブが非表示でも描画を続けるため）
 */
export type FrameSource = 'raf' | 'worker'

export interface LoadedVrmInfo {
  spec: string
  title: string
}

/**
 * VRM の描画を一手に引き受ける。Vue コンポーネントはこのクラス越しにだけ three.js を扱う。
 */
export class VrmViewer {
  readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  /** 背景（単色か、画像・動画を敷く 2D） */
  private background!: StageBackground
  /** 背景になじませる光（背景の空と地面の色）と、足元の影 */
  private lighting!: StageLighting
  private readonly shadow = new GroundShadow(this.scene)
  private readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 20)
  private readonly lookAtPoint = new THREE.Vector3(0, 1.3, 0)
  /** 注視点の高さ：上半身を映すとき（顔のあたり）と、いちばん引いたとき（全身の真ん中） */
  private upperBodyY = 1.3
  private fullBodyY = 0.8
  private zoom = 1
  /** 右ドラッグで回したカメラの向き（ラジアン。yaw：左右、pitch：上下） */
  private orbitYaw = 0
  private orbitPitch = 0
  /** 右ボタンで回している最中の、前のポインターの位置 */
  private orbitFrom: { x: number; y: number; pointerId: number; mode: 'orbit' | 'pan' } | null = null
  /** ホイールボタンのドラッグで動かした注視点のずれ（カメラを平行に動かす） */
  private readonly panOffset = new THREE.Vector3()

  private vrm: VRM | null = null
  private idle: IdleMotion | null = null
  private expression: ExpressionController | null = null
  /** 動きのファイル（.vrma・Mixamo の .fbx）の再生。登録した動きは、モデルを読み替えても引き継ぐ */
  private readonly motions = new MotionPlayer()
  /** モデルを読み替えても姿勢の様子・過ごし方を引き継ぐ */
  private motionState: MotionState = 'idle'
  private mood: IdleMood = 'awake'
  /** 腰回りを崩れにくくする（モデルを読み替えても引き継ぐ） */
  private steadyWaist = true
  private talkGestures = true
  private emotion: Emotion = 'neutral'

  private frameSource: FrameSource = 'raf'
  private maxFps = 60
  private lastTime = 0
  private lastRenderTime = 0
  private rafWindow: Window | null = null
  private rafId = 0
  private worker: Worker | null = null
  private resizeObserver: ResizeObserver | null = null
  private running = false

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.style.display = 'block'
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true })
    const light = new THREE.DirectionalLight(0xffffff, Math.PI)
    light.position.set(1, 1, 1).normalize()
    this.scene.add(light)
    this.lighting = new StageLighting(this.scene, light, Math.PI)
    this.background = new StageBackground(this.scene, (palette) => this.lighting.setPalette(palette))
    this.background.setColor('#e8eef5')

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerdown', this.onOrbitStart)
    this.canvas.addEventListener('pointerup', this.onOrbitEnd)
    this.canvas.addEventListener('pointercancel', this.onOrbitEnd)
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
  }

  /** container に canvas を入れて描画を始める */
  mount(container: HTMLElement): void {
    container.appendChild(this.canvas)
    this.running = true
    this.rebind()
  }

  /**
   * canvas が別ウィンドウ（小窓）へ移った・戻ったあとに呼ぶ。
   * rAF とサイズ監視を、canvas が今いるウィンドウに付け替える。
   */
  rebind(): void {
    const win = this.canvas.ownerDocument.defaultView
    if (!win) return

    this.resizeObserver?.disconnect()
    const parent = this.canvas.parentElement
    if (parent) {
      this.resizeObserver = new win.ResizeObserver(() => this.resize())
      this.resizeObserver.observe(parent)
    }
    this.renderer.setPixelRatio(Math.min(win.devicePixelRatio, 2))
    this.resize()
    this.restartLoop()
  }

  setFrameSource(source: FrameSource): void {
    this.frameSource = source
    this.restartLoop()
  }

  setMaxFps(fps: number): void {
    this.maxFps = fps
    if (this.frameSource === 'worker') this.restartLoop()
  }

  setBackgroundColor(color: string): void {
    this.background.setColor(color)
  }

  /** 画像・動画を背景にする（縦横比を保ったままステージいっぱいに敷く）。読めなければ例外。元の大きさを返す */
  async setBackgroundImage(
    file: Blob,
    media: 'image' | 'video',
    view: BackdropView,
    blur: number,
  ): Promise<{ width: number; height: number }> {
    await this.background.setImage(file, media, view, blur)
    return { ...this.background.size }
  }

  /** 背景の画像・動画の見せ方（中心・拡大・明るさ・奥行き感） */
  setBackgroundView(view: BackdropView): void {
    this.background.setView(view)
  }

  /** 話している間に手ぶりをするか（キャラクターごと。手が体や服にめり込むモデルでは切る） */
  setTalkGestures(on: boolean): void {
    this.talkGestures = on
    this.idle?.setTalkGestures(on)
  }

  /** 腰回りを崩れにくくする（背骨の回転の多くを胸へ移す）。腰の飾りが背骨にぶら下がっているモデル向け */
  setSteadyWaist(on: boolean): void {
    this.steadyWaist = on
    this.idle?.setSteadyWaist(on)
  }

  /** 足元の影の濃さ（0〜1。0 で出さない） */
  setGroundShadow(strength: number): void {
    this.shadow.setStrength(strength)
  }

  /** 背景の色をアバターの光に混ぜる強さ（0〜1。0 で今までどおりの白い光） */
  setBackdropLight(strength: number): void {
    this.lighting.setStrength(strength)
  }

  /** 動画の背景を止める・動かす */
  setBackgroundPaused(paused: boolean): void {
    this.background.setPaused(paused)
  }

  async load(source: ArrayBuffer | string): Promise<LoadedVrmInfo> {
    const vrm = await loadVrm(source)
    this.setVrm(vrm)
    const meta = vrm.meta
    const title = meta.metaVersion === '0' ? meta.title : meta.name
    return { spec: vrmSpecLabel(vrm), title: title ?? '' }
  }

  /** 表示中のモデルを外す（キャラクターにモデルがまだ入っていないとき） */
  clear(): void {
    if (!this.vrm) return
    this.scene.remove(this.vrm.scene)
    disposeVrm(this.vrm)
    this.vrm = null
    this.idle = null
    this.expression = null
    this.motions.detach()
    this.shadow.attach(null)
  }

  setEmotion(emotion: Emotion): void {
    this.emotion = emotion
    this.expression?.setEmotion(emotion)
    this.idle?.setEmotion(emotion)
  }

  /** 話すときの合図（文の終わりでうなずき・首かしげ） */
  speechCue(cue: SpeechCue): void {
    this.idle?.speechCue(cue)
  }

  setMouth(viseme: Viseme | null, weight: number): void {
    this.expression?.setMouth(viseme, weight)
  }

  /** 会話の様子に合わせて姿勢を切り替える（聞いている・考えている・作業中・話している） */
  setMotion(state: MotionState): void {
    this.motionState = state
    this.motions.setState(state)
    this.idle?.setState(state)
  }

  /**
   * 役に動きのファイル（.vrma か Mixamo の .fbx のデータ）をパターンの1つとして足す。同じ id なら入れ替える。
   * どちらとしても読めなければ例外（登録はしない）
   */
  async addMotionFile(role: MotionRole, id: string, data: ArrayBuffer, name = ''): Promise<void> {
    this.motions.add(role, id, await parseMotion(data), name)
  }

  /** 役から動きのパターンを外す */
  removeMotionFile(role: MotionRole, id: string): void {
    this.motions.remove(role, id)
  }

  /** 動きのパターンをすべて外す（キャラクターを切り替えたとき） */
  clearMotionFiles(): void {
    this.motions.clear()
  }

  /** 1回きりの動き（あいさつ・喜ぶ・気まぐれ）を再生する。パターンは乱数で選ぶ。登録されていなければ false */
  playMotion(role: MotionRole): boolean {
    return this.motions.playGesture(role)
  }

  /** 動きのファイルを1回だけ再生して確かめる（ループの役も1回だけ流す）。id でパターンを選ぶ */
  previewMotion(role: MotionRole, id?: string): boolean {
    return this.motions.playGesture(role, true, id)
  }

  /** 今の動きに合わせる顔（動きの重みをかけたもの）。合わせる顔が無ければ何もしない値 */
  private motionFace(): ReturnType<typeof evaluateFace> {
    const drive = this.motions.face
    if (!drive) return NO_FACE
    const face = evaluateFace(drive.face, drive.t)
    const mouths: typeof face.mouths = {}
    for (const [shape, amount] of Object.entries(face.mouths) as [keyof typeof face.mouths, number][]) mouths[shape] = amount * drive.weight
    return {
      emotion: face.emotion,
      strength: face.strength * drive.weight,
      eyeClose: face.eyeClose * drive.weight,
      eyeSmile: face.eyeSmile * drive.weight,
      mouthOpen: face.mouthOpen * drive.weight,
      mouths,
    }
  }

  /** カメラを、上半身が収まる最初の位置・向き・ズームに戻す（回した向きと平行に動かしたぶんも戻す） */
  resetCamera(): void {
    this.frameUpperBody()
  }

  /** 1回きりの動き（動きのファイル）を再生している最中か */
  get isPlayingMotion(): boolean {
    return this.motions.isPlayingGesture
  }

  hasMotion(role: MotionRole): boolean {
    return this.motions.has(role)
  }

  /** 小さく1回うなずく */
  nod(): void {
    this.idle?.nod()
  }

  /** 会話していないときの過ごし方（ふつう・退屈・居眠り）。モデルを読み替えても引き継ぐ */
  setMood(mood: IdleMood): void {
    this.mood = mood
    this.idle?.setMood(mood)
  }

  /** ひとりで過ごすときの身ぶりを1回する */
  gesture(gesture: Gesture): void {
    this.idle?.playGesture(gesture)
  }

  get isGesturing(): boolean {
    return this.idle?.isGesturing ?? false
  }

  /**
   * 画面上の位置（clientX/Y）が、アバターのどこに当たるか。頭（髪・顔を含む首から上）か体か、
   * 当たらなければ null（背景をクリックしたとき）
   */
  pick(clientX: number, clientY: number): 'head' | 'body' | null {
    if (!this.vrm) return null
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const hit = ray.intersectObject(this.vrm.scene, true).find((h) => (h.object as THREE.Mesh).isMesh)
    if (!hit) return null
    // head ボーンは首の付け根あたりにあるので、そこより上なら頭
    const head = this.vrm.humanoid.getRawBoneNode('head')
    const neckY = head ? head.getWorldPosition(new THREE.Vector3()).y : Infinity
    return hit.point.y >= neckY ? 'head' : 'body'
  }

  /** マウスの位置を、カメラの前（アバターの顔のあたりの面）の点にして目で追わせる */
  /**
   * 右ボタンのドラッグでカメラをモデルのまわりに回し、ホイールボタン（または Shift＋右ボタン）のドラッグでカメラを平行に動かす
   */
  private onOrbitStart = (e: PointerEvent): void => {
    const pan = e.button === 1 || (e.button === 2 && e.shiftKey)
    if (!pan && e.button !== 2) return
    // ホイールボタンを押したときの自動スクロールを出さない
    e.preventDefault()
    this.orbitFrom = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, mode: pan ? 'pan' : 'orbit' }
    this.canvas.setPointerCapture(e.pointerId)
  }

  private onOrbitEnd = (e: PointerEvent): void => {
    if (!this.orbitFrom || this.orbitFrom.pointerId !== e.pointerId) return
    this.orbitFrom = null
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
  }

  /** 右クリックのメニューは出さない（右ドラッグでカメラを回すため） */
  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.orbitFrom && this.orbitFrom.pointerId === e.pointerId) {
      const dx = e.clientX - this.orbitFrom.x
      const dy = e.clientY - this.orbitFrom.y
      if (this.orbitFrom.mode === 'pan') {
        // ホイールボタンのドラッグ中は、カメラを画面の向きに平行に動かす（つかんだ場所がマウスについてくる速さ）
        this.pan(dx, dy)
      } else {
        // 右ドラッグ中はカメラを回す（目線は追わない）
        this.orbitYaw -= dx * ORBIT_SPEED
        this.orbitPitch = Math.min(ORBIT_PITCH_MAX, Math.max(ORBIT_PITCH_MIN, this.orbitPitch + dy * ORBIT_SPEED))
      }
      this.orbitFrom.x = e.clientX
      this.orbitFrom.y = e.clientY
      this.updateCamera()
      return
    }
    if (!this.idle) return
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    // 顔の少し手前（カメラの側へ 0.3）の、カメラに向いた面との交点を見る先にする（カメラを回しても同じ見え方）
    const normal = this.camera.position.clone().sub(this.lookAtPoint).normalize()
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.lookAtPoint.clone().addScaledVector(normal, 0.3))
    const point = new THREE.Vector3()
    if (ray.ray.intersectPlane(plane, point)) this.idle.lookAtPointer(point)
  }

  dispose(): void {
    this.background.dispose()
    this.shadow.dispose()
    this.running = false
    this.stopLoop()
    this.resizeObserver?.disconnect()
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerdown', this.onOrbitStart)
    this.canvas.removeEventListener('pointerup', this.onOrbitEnd)
    this.canvas.removeEventListener('pointercancel', this.onOrbitEnd)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    if (this.vrm) disposeVrm(this.vrm)
    this.renderer.dispose()
    this.canvas.remove()
  }

  private setVrm(vrm: VRM): void {
    if (this.vrm) {
      this.scene.remove(this.vrm.scene)
      disposeVrm(this.vrm)
    }
    this.vrm = vrm
    // 表情が登録されていないモデル（MMD から変換したものなど）は、顔のモーフの名前から表情を組み立てる。口だけの形も足す
    const built = registerFallbackExpressions(vrm)
    this.scene.add(vrm.scene)
    this.frameUpperBody()
    this.idle = new IdleMotion(vrm, this.camera)
    this.idle.setState(this.motionState)
    this.idle.setMood(this.mood)
    this.idle.setSteadyWaist(this.steadyWaist)
    this.idle.setTalkGestures(this.talkGestures)
    this.idle.setEmotion(this.emotion)
    this.motions.attach(vrm)
    this.motions.setState(this.motionState)
    this.shadow.attach(vrm)
    this.expression = new ExpressionController(vrm, built)
    this.expression.setEmotion(this.emotion)
    // 待機姿勢を当てた状態を揺れものの初期状態にして、読み込み直後に髪などが跳ねないようにする
    vrm.update(0)
    vrm.springBoneManager?.reset()
  }

  /** カメラを画面の向きに平行に動かす（dx・dy は画面のピクセル） */
  private pan(dx: number, dy: number): void {
    const height = this.canvas.clientHeight || 1
    const distance = BASE_DISTANCE * this.zoom
    const perPixel = (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / height
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1)
    this.panOffset.addScaledVector(right, -dx * perPixel).addScaledVector(up, dy * perPixel)
    this.panOffset.clampLength(0, PAN_LIMIT)
  }

  /** 頭の位置から、上半身が収まる注視点を決める（head ボーンは首の付け根あたりにある） */
  private frameUpperBody(): void {
    if (!this.vrm) return
    this.vrm.scene.updateMatrixWorld(true)
    const head = this.vrm.humanoid.getNormalizedBoneNode('head')
    const headPos = head ? head.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 1.4, 0)
    const ground = this.vrm.scene.position.y
    this.upperBodyY = headPos.y - 0.1
    // 引いたときは、頭のてっぺん（頭のボーンより少し上）から足元までの真ん中を見る
    this.fullBodyY = ground + (headPos.y + 0.12 - ground) / 2
    this.lookAtPoint.set(0, this.upperBodyY, 0)
    this.panOffset.set(0, 0, 0)
    this.zoom = 1
    this.orbitYaw = 0
    this.orbitPitch = 0
    this.updateCamera()
  }

  private updateCamera(): void {
    // 引くほど注視点を全身の真ん中へ下ろし、いちばん引くと足元まで映る（足元の影も見える）
    const t = THREE.MathUtils.clamp((this.zoom - 1) / (ZOOM_MAX - 1), 0, 1)
    this.lookAtPoint
      .set(0, THREE.MathUtils.lerp(this.upperBodyY, this.fullBodyY, THREE.MathUtils.smoothstep(t, 0, 1)), 0)
      .add(this.panOffset)
    // 注視点を中心に、右ドラッグで回した向きから見る
    const d = BASE_DISTANCE * this.zoom
    const flat = Math.cos(this.orbitPitch) * d
    this.camera.position.set(
      this.lookAtPoint.x + Math.sin(this.orbitYaw) * flat,
      this.lookAtPoint.y + Math.sin(this.orbitPitch) * d,
      this.lookAtPoint.z + Math.cos(this.orbitYaw) * flat,
    )
    this.camera.lookAt(this.lookAtPoint)
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * Math.exp(e.deltaY * 0.001)))
    this.updateCamera()
  }

  private resize(): void {
    const parent = this.canvas.parentElement
    if (!parent) return
    const { clientWidth: w, clientHeight: h } = parent
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private restartLoop(): void {
    this.stopLoop()
    if (!this.running) return
    this.lastTime = performance.now()

    if (this.frameSource === 'worker') {
      this.worker = new Worker(new URL('./tick.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = () => this.frame(performance.now())
      this.worker.postMessage({ fps: this.maxFps })
      return
    }

    const win = this.canvas.ownerDocument.defaultView
    if (!win) return
    this.rafWindow = win
    const loop = () => {
      this.rafId = win.requestAnimationFrame(loop)
      // rAF の引数は小窓だと時刻の基準がずれるので、本体の performance.now() にそろえる
      const now = performance.now()
      // 小窓などで fps 上限を下げているときは間引く（1ms の余裕は rAF の揺れ対策）
      if (now - this.lastRenderTime < 1000 / this.maxFps - 1) return
      this.frame(now)
    }
    this.rafId = win.requestAnimationFrame(loop)
  }

  private stopLoop(): void {
    if (this.rafWindow) {
      this.rafWindow.cancelAnimationFrame(this.rafId)
      this.rafWindow = null
    }
    if (this.worker) {
      this.worker.postMessage('stop')
      this.worker.terminate()
      this.worker = null
    }
  }

  private frame(now: number): void {
    // 長く止まっていた直後に動きが飛ばないよう、delta に上限を設ける
    const delta = Math.min((now - this.lastTime) / 1000, 0.1)
    this.lastTime = now
    this.lastRenderTime = now

    if (this.vrm) {
      // 動きのファイルを再生してから、コードの動きをその上に重ねる
      this.motions.update(delta)
      this.idle?.setClipDrive(this.motions.drive)
      // 動きのファイルに合わせた顔（あくびで目を閉じて口を開ける、拍手で笑顔、など）を重ねる
      const face = this.motionFace()
      this.idle?.setFaceEyeClose(face.eyeClose)
      this.idle?.update(delta)
      // 動きのファイルの顔が無ければ、コードの身ぶり（ほほえむ・くつろぐなど）の顔を出す
      const own = this.idle?.face
      const useOwn = !!own && !face.emotion && face.strength <= 0.001 && own.strength > 0.001
      const shown = useOwn && own ? own : face
      this.expression?.setIdleMouth(Math.max(this.idle?.mouthOpen ?? 0, face.mouthOpen))
      this.expression?.setMotionFace(shown.emotion ?? null, shown.strength, shown.mouths, Math.max(face.eyeSmile, own?.eyeSmile ?? 0))
      this.expression?.update(delta)
      this.vrm.update(delta)
      this.shadow.update()
    }
    this.background.render(this.renderer, this.camera, { yaw: this.orbitYaw, pitch: this.orbitPitch })
  }
}

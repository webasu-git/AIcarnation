import * as THREE from 'three'
import { paletteFromPixels, type BackdropPalette } from './stageLighting'

/** 背景の画像・動画の見せ方 */
export interface BackdropView {
  /** 見せる中心（0〜1） */
  focusX: number
  focusY: number
  /** 拡大（1〜3） */
  zoom: number
  /** 明るさ（0.2〜1.5） */
  brightness: number
  /** カメラを回すと背景が少しずれる（奥行き感） */
  parallax: boolean
}

/** 奥行き感：カメラを 1 ラジアン回したときに、背景を画面の何割ずらすか */
const PARALLAX_AMOUNT = 0.08
/** ぼかした画像を作るときの、長い辺の上限（ぼかすと細かさは要らないので、小さくして軽くする） */
const BLUR_MAX_SIZE = 1600
/** 光の色を読み取るときに縮める大きさ（平均を取るだけなので小さくてよい） */
const SAMPLE_SIZE = 32
/** 動画の背景から光の色を読み直す間隔（ミリ秒） */
const VIDEO_SAMPLE_MS = 1500

/**
 * ステージの背景。単色か、画像・動画を縦横比を保ったままステージいっぱいに敷く（2D）。
 * 背景は三角形2枚の板として、アバターより先に描く（小窓や動画の PiP にも一緒に映る）。
 * ぼかしは画像を読み込むときに一度だけかけ、動画は「背景の動きを止める」で止められる
 */
export class StageBackground {
  private readonly backdropScene = new THREE.Scene()
  private readonly backdropCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private texture: THREE.Texture | null = null
  private video: HTMLVideoElement | null = null
  private url = ''
  private paused = false
  private view: BackdropView = { focusX: 0.5, focusY: 0.5, zoom: 1, brightness: 1, parallax: false }
  /** 読み込みが重なったら、最後に頼んだものだけを使う */
  private token = 0
  /** 元の画像・動画の大きさ（ピクセル） */
  size = { width: 0, height: 0 }
  private sampleTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly scene: THREE.Scene,
    /** 背景から読み取った光の色を知らせる（アバターの光を背景になじませるため） */
    private readonly onPalette: (palette: BackdropPalette) => void = () => {},
  ) {
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false }))
    this.plane.visible = false
    this.backdropScene.add(this.plane)
  }

  setColor(color: string): void {
    ++this.token
    this.release()
    this.scene.background = new THREE.Color(color)
    const c = new THREE.Color(color)
    const rgb: [number, number, number] = [c.r, c.g, c.b]
    this.onPalette({ sky: rgb, ground: rgb })
  }

  /** 画像・動画を背景にする。blur（0〜10）は画像だけ。読めなければ例外（背景は前のまま） */
  async setImage(file: Blob, media: 'image' | 'video', view: BackdropView, blur: number): Promise<void> {
    const mine = ++this.token
    const url = URL.createObjectURL(file)
    let texture: THREE.Texture
    let video: HTMLVideoElement | null = null
    let width: number
    let height: number
    try {
      if (media === 'video') {
        video = await loadVideo(url)
        texture = new THREE.VideoTexture(video)
        width = video.videoWidth
        height = video.videoHeight
      } else {
        const image = await loadImage(url)
        width = image.naturalWidth
        height = image.naturalHeight
        texture = blur > 0 ? new THREE.CanvasTexture(blurred(image, blur)) : new THREE.Texture(image)
        texture.needsUpdate = true
      }
    } catch (err) {
      URL.revokeObjectURL(url)
      throw err
    }
    if (mine !== this.token) {
      texture.dispose()
      video?.pause()
      URL.revokeObjectURL(url)
      return
    }
    texture.colorSpace = THREE.SRGBColorSpace
    this.release()
    this.texture = texture
    this.video = video
    this.url = url
    this.size = { width, height }
    this.plane.material.map = texture
    this.plane.material.needsUpdate = true
    this.plane.visible = true
    this.scene.background = null
    this.setView(view)
    this.applyPaused()
    const source = video ?? (texture.image as CanvasImageSource)
    this.samplePalette(source)
    if (video) this.sampleTimer = setInterval(() => !this.paused && this.samplePalette(video), VIDEO_SAMPLE_MS)
  }

  /** 背景の画像・動画を小さく縮め、上のほう・下のほうの色を読み取る */
  private samplePalette(source: CanvasImageSource): void {
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE_SIZE
    canvas.height = SAMPLE_SIZE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    try {
      ctx.drawImage(source, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      this.onPalette(paletteFromPixels(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data, SAMPLE_SIZE, SAMPLE_SIZE))
    } catch {
      // 読み取れなくても背景は出す（光は前のまま）
    }
  }

  setView(view: BackdropView): void {
    this.view = view
    this.plane.material.color.setScalar(view.brightness)
  }

  /** 動画の背景を止める・動かす */
  setPaused(paused: boolean): void {
    this.paused = paused
    this.applyPaused()
  }

  /** 1コマ描く。画像・動画なら背景の板を先に描き、その上にアバターの場面を描く。orbit はカメラの向き（奥行き感に使う） */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, orbit: { yaw: number; pitch: number }): void {
    if (!this.texture) {
      renderer.render(this.scene, camera)
      return
    }
    this.fit(camera.aspect, orbit)
    renderer.autoClear = false
    renderer.clear()
    renderer.render(this.backdropScene, this.backdropCamera)
    renderer.clearDepth()
    renderer.render(this.scene, camera)
    renderer.autoClear = true
  }

  dispose(): void {
    ++this.token
    this.release()
    this.plane.geometry.dispose()
    this.plane.material.dispose()
  }

  /**
   * 縦横比を保ったまま、ステージいっぱいに敷く（はみ出た部分は切る）。拡大と見せる中心で、どこを残すかを決め、
   * 奥行き感があれば、カメラの向きに合わせて少しずらす
   */
  private fit(aspect: number, orbit: { yaw: number; pitch: number }): void {
    const texture = this.texture
    const { width, height } = this.size
    if (!texture || width === 0 || height === 0) return
    const imageAspect = width / height
    const zoom = Math.max(1, this.view.zoom)
    const repeatX = (imageAspect > aspect ? aspect / imageAspect : 1) / zoom
    const repeatY = (imageAspect > aspect ? 1 : imageAspect / aspect) / zoom
    let fx = this.view.focusX
    let fy = this.view.focusY
    if (this.view.parallax) {
      fx += orbit.yaw * PARALLAX_AMOUNT
      fy -= orbit.pitch * PARALLAX_AMOUNT
    }
    const clamp = (v: number) => Math.min(1, Math.max(0, v))
    texture.repeat.set(repeatX, repeatY)
    texture.offset.set((1 - repeatX) * clamp(fx), (1 - repeatY) * (1 - clamp(fy)))
  }

  private applyPaused(): void {
    if (!this.video) return
    if (this.paused) this.video.pause()
    // 音は出さない（muted）ので、操作が無くても再生できる
    else void this.video.play().catch(() => undefined)
  }

  private release(): void {
    clearInterval(this.sampleTimer)
    this.sampleTimer = undefined
    this.texture?.dispose()
    this.texture = null
    if (this.video) {
      this.video.pause()
      this.video.removeAttribute('src')
      this.video.load()
      this.video = null
    }
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = ''
    this.plane.visible = false
    this.plane.material.map = null
    this.size = { width: 0, height: 0 }
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('画像を読み込めませんでした'))
    image.src = url
  })
}

/** 音を消した繰り返しの動画を、最初の絵が出せるまで読み込む */
function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.muted = true
    video.loop = true
    video.playsInline = true
    video.preload = 'auto'
    video.addEventListener('loadeddata', () => resolve(video), { once: true })
    video.addEventListener('error', () => reject(new Error('動画を読み込めませんでした')), { once: true })
    video.src = url
  })
}

/**
 * ぼかした画像を作る（blur は 0〜10。長い辺の 0.4% ずつ）。端が透けて暗くならないよう、まわりに画像を引き伸ばして足してから
 * ぼかし、元の大きさに切り出す
 */
function blurred(image: HTMLImageElement, blur: number): HTMLCanvasElement {
  const scale = Math.min(1, BLUR_MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.round(image.naturalWidth * scale)
  const h = Math.round(image.naturalHeight * scale)
  const radius = (Math.max(w, h) * 0.004 * blur) | 0
  const pad = radius * 2
  const padded = document.createElement('canvas')
  padded.width = w + pad * 2
  padded.height = h + pad * 2
  const pctx = padded.getContext('2d')!
  pctx.drawImage(image, 0, 0, padded.width, padded.height)
  pctx.drawImage(image, pad, pad, w, h)
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')!
  ctx.filter = `blur(${radius}px)`
  ctx.drawImage(padded, -pad, -pad)
  return out
}

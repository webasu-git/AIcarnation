import type { Gesture, IdleMood } from '../vrm/idle'

/** 行動の監督が動かす相手。VrmViewer が満たす */
export interface IdleBody {
  setMood(mood: IdleMood): void
  gesture(gesture: Gesture): void
  /** 身ぶりの最中か（最中は次の身ぶりを出さない） */
  readonly isGesturing: boolean
}

/** 待機の時間の決まり（ミリ秒） */
export interface DirectorTiming {
  /** 会話のあと、身ぶりを始めるまで（余韻） */
  afterglow: number
  /** なにも起きないまま、この時間がたつと退屈する */
  boredAfter: number
  /** さらに、この時間がたつと居眠りする（会話からの通算） */
  dozeAfter: number
  /** ふつうに待っているときの身ぶりの間隔 */
  awakeGesture: [number, number]
  /** 退屈しているときの身ぶりの間隔 */
  boredGesture: [number, number]
}

export const DEFAULT_TIMING: DirectorTiming = {
  afterglow: 30_000,
  boredAfter: 10 * 60_000,
  dozeAfter: 30 * 60_000,
  awakeGesture: [25_000, 50_000],
  boredGesture: [15_000, 30_000],
}

/** 時間の決まりを speed 倍に速める（試すとき用。?idle-speed=60 なら 1 分が 1 秒） */
/** 身ぶりの多さごとの、身ぶりの間隔の倍率（しないは Infinity） */
const GESTURE_INTERVAL_SCALE = { more: 0.6, normal: 1, less: 2, off: Infinity } as const

/**
 * 利用者の設定に合わせた時間の決まり。身ぶりの多さで間隔を伸び縮みさせ、居眠りしないなら居眠りの時刻を無くす
 * （退屈はそのまま。退屈しても居眠りには入らない）
 */
export function timingForSettings(
  timing: DirectorTiming,
  gestures: keyof typeof GESTURE_INTERVAL_SCALE,
  doze: boolean,
): DirectorTiming {
  const k = GESTURE_INTERVAL_SCALE[gestures]
  return {
    ...timing,
    dozeAfter: doze ? timing.dozeAfter : Infinity,
    awakeGesture: [timing.awakeGesture[0] * k, timing.awakeGesture[1] * k],
    boredGesture: [timing.boredGesture[0] * k, timing.boredGesture[1] * k],
  }
}

export function scaleTiming(timing: DirectorTiming, speed: number): DirectorTiming {
  const s = (ms: number) => ms / speed
  return {
    afterglow: s(timing.afterglow),
    boredAfter: s(timing.boredAfter),
    dozeAfter: s(timing.dozeAfter),
    awakeGesture: [s(timing.awakeGesture[0]), s(timing.awakeGesture[1])],
    boredGesture: [s(timing.boredGesture[0]), s(timing.boredGesture[1])],
  }
}

/** ふつうに待っているとき：見回す・首かしげ・ほほえむ */
const AWAKE_GESTURES: Gesture[] = ['lookAround', 'tilt', 'smile', 'lookAround', 'tilt', 'smile']
/** 退屈しているとき：あくび・リズムに乗る・見回す・首かしげ */
const BORED_GESTURES: Gesture[] = ['yawn', 'groove', 'lookAround', 'yawn', 'tilt', 'groove']

/**
 * 出来事の種類。会話（Claude Code の合図・自分の発言）と、アバターに触れた（クリック）
 */
export type ActivityKind = 'conversation' | 'touch'

export interface DirectorEvents {
  /** 居眠りから目を覚ました（何がきっかけか） */
  onWake?(kind: ActivityKind): void
  /** 過ごし方が変わった */
  onMood?(mood: IdleMood): void
}

/**
 * 会話していないときの過ごし方を決める（段階A：ひとりで過ごす）。
 * 最後の出来事からの時間で「ふつう → 退屈 → 居眠り」と移り、その間ときどき身ぶりをする。
 * 出来事が起きたら、居眠りしていれば目を覚ます。会話中（isBusy）は何もしない。
 *
 * tick() を一定間隔で呼んでもらう（start() が呼ぶ）。時刻と乱数は差し替えられる（テスト用）
 */
export class BehaviorDirector {
  private lastActivity: number
  private mood: IdleMood = 'awake'
  private nextGestureAt: number
  private timer: number | undefined

  constructor(
    private readonly body: IdleBody,
    private readonly isBusy: () => boolean,
    private timing: DirectorTiming = DEFAULT_TIMING,
    private readonly events: DirectorEvents = {},
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = Math.random,
  ) {
    this.lastActivity = now()
    this.nextGestureAt = this.lastActivity + timing.afterglow
  }

  /** 時間の決まりを差し替える（設定を変えたとき）。次の身ぶりの時刻も、新しい間隔で決め直す */
  setTiming(timing: DirectorTiming): void {
    this.timing = timing
    const [min, max] = timing.awakeGesture
    this.nextGestureAt = this.now() + min + this.random() * (max - min)
  }

  get currentMood(): IdleMood {
    return this.mood
  }

  start(win: Window = window, intervalMs = 1000): void {
    this.stop()
    this.timer = win.setInterval(() => this.tick(), intervalMs)
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 出来事が起きた。居眠りしていれば目を覚まし、待機の時間を数え直す */
  activity(kind: ActivityKind): void {
    const wasDozing = this.mood === 'dozing'
    this.lastActivity = this.now()
    this.nextGestureAt = this.lastActivity + this.timing.afterglow
    this.setMood('awake')
    if (wasDozing) {
      this.body.gesture('wake')
      this.events.onWake?.(kind)
    }
  }

  tick(): void {
    const now = this.now()
    if (this.isBusy()) {
      // 会話中は待機の時間を数えない
      this.lastActivity = now
      this.nextGestureAt = now + this.timing.afterglow
      this.setMood('awake')
      return
    }
    const idleFor = now - this.lastActivity
    this.setMood(idleFor >= this.timing.dozeAfter ? 'dozing' : idleFor >= this.timing.boredAfter ? 'bored' : 'awake')
    if (this.mood === 'dozing' || now < this.nextGestureAt || this.body.isGesturing) return
    // 身ぶりを「しない」にしているときは出さない
    if (!Number.isFinite(this.timing.awakeGesture[0])) return
    const [min, max] = this.mood === 'bored' ? this.timing.boredGesture : this.timing.awakeGesture
    this.nextGestureAt = now + min + this.random() * (max - min)
    // 居眠りに入る少し前（退屈の終わりごろ）は、あくびを多めにする
    const sleepy = this.mood === 'bored' && idleFor >= this.timing.dozeAfter * 0.8
    const choices = this.mood === 'bored' ? (sleepy ? ['yawn', 'yawn', 'lookAround'] as Gesture[] : BORED_GESTURES) : AWAKE_GESTURES
    this.body.gesture(choices[Math.floor(this.random() * choices.length)] ?? 'lookAround')
  }

  private setMood(mood: IdleMood): void {
    if (mood === this.mood) return
    this.mood = mood
    this.body.setMood(mood)
    this.events.onMood?.(mood)
  }
}

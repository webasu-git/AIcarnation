import type { BridgeEvent } from '@aicarnation/shared'
import type { IdleMood } from '../vrm/idle'
import { greetingScene, pickLine, type LineBook, type Scene } from './lines'

/** 反応の決まり（ミリ秒） */
export interface ReactionTiming {
  /** 反応どうしの最低の間隔（あいさつ・目覚め・テストの結果などは例外） */
  cooldown: number
  /** つつかれたときの反応の最低の間隔 */
  touchCooldown: number
  /** この時間より長く作業が続いたら、一言かける */
  longTask: number
  /** この時間より長く話しかけられなかったら、次に話しかけられたとき「おかえり」と言う */
  absence: number
}

export const DEFAULT_REACTION_TIMING: ReactionTiming = {
  cooldown: 45_000,
  touchCooldown: 20_000,
  longTask: 2 * 60_000,
  absence: 30 * 60_000,
}

export interface ReactorDeps {
  /** 台詞（感情タグ付き）を話す。scene はどの場面の台詞か（身ぶりを合わせるため）。話せなかった（返答を話している最中など）ときは false */
  say(raw: string, scene: Scene): boolean
  /** 今の台詞帳 */
  book(): LineBook
  now?(): number
  random?(): number
}

/** 直前に使った台詞を、いくつまで覚えて避けるか */
const RECENT_LINES = 6
/** 退屈したときに独り言を言う確率 */
const BORED_TALK_CHANCE = 0.5

/** 会話の出来事。Claude Code の合図か、自分で発言した（send） */
export type ActivityEvent = BridgeEvent | { type: 'send' }

/**
 * 出来事に一言反応する（段階B）。台詞は台詞帳から選ぶのでモデルは呼ばない。
 * 反応しすぎないよう間隔をあけ、同じ台詞が続かないようにする。
 */
export class LineReactor {
  private lastSpokeAt = -Infinity
  private lastTouchAt = -Infinity
  private readonly recent: string[] = []
  private lastActivity: number
  private workingSince: number | null = null
  private longTaskDone = false
  private failedThisTurn = false
  private greeted = false
  private boredTalked = false
  private readonly now: () => number
  private readonly random: () => number

  constructor(
    private readonly deps: ReactorDeps,
    private readonly timing: ReactionTiming = DEFAULT_REACTION_TIMING,
  ) {
    this.now = deps.now ?? (() => Date.now())
    this.random = deps.random ?? Math.random
    this.lastActivity = this.now()
  }

  /** 場面の台詞を1つ話す。force でなければ、前の反応から間隔があいているときだけ */
  private react(scene: Scene, force = false): boolean {
    const now = this.now()
    if (!force && now - this.lastSpokeAt < this.timing.cooldown) return false
    const line = pickLine(this.deps.book(), scene, this.recent, this.random)
    if (!line || !this.deps.say(line, scene)) return false
    this.lastSpokeAt = now
    this.recent.push(line)
    if (this.recent.length > RECENT_LINES) this.recent.shift()
    return true
  }

  /** 画面を開いて Claude Code とつながったとき、時刻に合わせてあいさつする（1回だけ） */
  greet(date: Date = new Date(this.now())): void {
    if (this.greeted) return
    this.greeted = true
    this.react(greetingScene(date), true)
  }

  onEvent(event: ActivityEvent): void {
    const now = this.now()
    switch (event.type) {
      case 'listening':
      case 'send':
        // 長く話しかけられなかったあとなら「おかえり」
        if (now - this.lastActivity >= this.timing.absence) this.react('welcomeBack', true)
        this.workingSince = null
        this.longTaskDone = false
        this.failedThisTurn = false
        break
      case 'working':
        // 要約を作っている間は作業ではない
        if (event.label === 'まとめています') this.workingSince = null
        else this.workingSince ??= now
        break
      case 'reply':
      case 'idle':
        this.workingSince = null
        break
      case 'notice':
        if (event.kind === 'tests-passed') this.react('testsPassed', true)
        else if (event.kind === 'tests-failed') this.react('testsFailed', true)
        else if (!this.failedThisTurn) {
          // コマンドの失敗はよくあるので、1回のやり取りにつき1度だけ
          this.failedThisTurn = true
          this.react('commandFailed')
        }
        break
    }
    this.lastActivity = now
  }

  /** 居眠りから、つつかれて目を覚ました */
  onWakeByTouch(): void {
    this.react('wakeUp', true)
  }

  /** 起きているときに、頭をなでられた・体をつつかれた。言葉で返したら true */
  onTouch(part: 'head' | 'body'): boolean {
    const now = this.now()
    if (now - this.lastTouchAt < this.timing.touchCooldown) return false
    if (!this.react(part === 'head' ? 'headPat' : 'touched', true)) return false
    this.lastTouchAt = now
    return true
  }

  /** 過ごし方が変わった。退屈し始めたら、ときどき独り言を言う */
  onMood(mood: IdleMood): void {
    if (mood === 'awake') this.boredTalked = false
    if (mood !== 'bored' || this.boredTalked) return
    this.boredTalked = true
    if (this.random() < BORED_TALK_CHANCE) this.react('bored')
  }

  /** 一定間隔で呼ぶ。長い作業に一言かける */
  tick(): void {
    if (this.workingSince === null || this.longTaskDone) return
    if (this.now() - this.workingSince < this.timing.longTask) return
    this.longTaskDone = true
    this.react('longTask')
  }
}

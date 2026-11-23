import type { Emotion } from '@aicarnation/shared'

/** 逆提案の時間の決まり（ミリ秒） */
export interface ProactiveTiming {
  /** なにも起きないまま、この時間がたつと提案を作り始める */
  prepareAfter: number
  /** この時間がたつと話す。提案がまだできていなければ、その回はあきらめる */
  speakAfter: number
}

/** 話しかけるまでの時間（分）から、時間の決まりを作る。作り始めるのは話す 1 分前（短いときは 8 割の時点） */
export function proactiveTiming(afterMin: number, speed = 1): ProactiveTiming {
  const speakAfter = (Math.max(1, afterMin) * 60_000) / speed
  return { prepareAfter: Math.max(speakAfter * 0.8, speakAfter - 60_000 / speed), speakAfter }
}

/** サーバーが返す提案。propose が false なら話さない */
export interface Suggestion {
  propose: boolean
  emotion?: Emotion
  text?: string
  reason?: string
  /** 話したと知らせるときの番号 */
  id?: string
}

export interface ProactiveDeps {
  /** 逆提案がオンか（設定・つながっているか） */
  enabled(): boolean
  /** 返事を話している・Claude が作業しているなど、話しかけてはいけない最中か */
  busy(): boolean
  /** 提案を作ってもらう（サーバーが材料を集め、Claude Code のモデルが答える） */
  request(): Promise<Suggestion>
  /** 台詞（感情タグ付き）を話す。話せなかったら false */
  say(raw: string): boolean
  /** 話したことを知らせる（提案の記録に残る） */
  spoken(id: string): void
  now?(): number
}

type Phase = 'waiting' | 'requesting' | 'ready' | 'done'

/**
 * 放置中の逆提案（アバターから話しかける）。
 * 会話の出来事が無いまま prepareAfter たつと提案を作り始め、speakAfter で話す。
 * その前に出来事があれば、作った提案は捨てる（話さない・知らせない）。話すのは、放置1回につき1度だけ
 */
export class ProactiveSuggester {
  private lastActivity: number
  private phase: Phase = 'waiting'
  private suggestion: Suggestion | null = null
  /** 出来事のたびに進める番号。古い依頼の答えが届いても、番号が違えば捨てる */
  private generation = 0
  private readonly now: () => number

  constructor(
    private readonly deps: ProactiveDeps,
    private timing: ProactiveTiming,
  ) {
    this.now = deps.now ?? (() => Date.now())
    this.lastActivity = this.now()
  }

  setTiming(timing: ProactiveTiming): void {
    this.timing = timing
  }

  /** 会話の出来事があった（話しかけられた・Claude が動いた）。数え直し、作った提案は捨てる */
  activity(): void {
    this.lastActivity = this.now()
    this.generation++
    this.phase = 'waiting'
    this.suggestion = null
  }

  /** 一定間隔で呼ぶ */
  tick(): void {
    if (!this.deps.enabled() || this.deps.busy()) {
      // オフ・取り込み中は放置に数えない
      if (this.phase !== 'waiting' || this.now() - this.lastActivity > 0) this.activity()
      return
    }
    const idle = this.now() - this.lastActivity
    if (this.phase === 'waiting' && idle >= this.timing.prepareAfter) {
      this.phase = 'requesting'
      const generation = this.generation
      this.deps.request().then(
        (suggestion) => {
          if (generation !== this.generation || this.phase !== 'requesting') return
          this.suggestion = suggestion
          this.phase = 'ready'
        },
        () => {
          if (generation === this.generation) this.phase = 'done'
        },
      )
      return
    }
    if (idle < this.timing.speakAfter) return
    if (this.phase === 'requesting') {
      // 話す時刻に間に合わなかった：この回はあきらめる（あとから届いた答えは捨てる）
      this.phase = 'done'
      return
    }
    if (this.phase !== 'ready') return
    const s = this.suggestion
    this.phase = 'done'
    this.suggestion = null
    if (!s?.propose || !s.text) return
    if (this.deps.say(`[${s.emotion ?? 'neutral'}] ${s.text}`) && s.id) this.deps.spoken(s.id)
  }
}

import { onBeforeUnmount, watch, type Ref } from 'vue'
import type { VrmViewer } from '../vrm/viewer'
import type { Gesture } from '../vrm/idle'
import type { BridgeConnection } from '../bridge/useBridge'
import { useAgentsStore } from '../stores/agents'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { BehaviorDirector, DEFAULT_TIMING, scaleTiming, timingForSettings } from './director'
import { loadLineBook } from './lineBook'
import { DEFAULT_LINES, type LineBook, type Scene } from './lines'
import type { MotionRole } from '../vrm/motion/clips'
import type { IdleBody } from './director'
import { DEFAULT_REACTION_TIMING, LineReactor, type ReactionTiming } from './reactions'

/**
 * 試すとき用：URL の ?idle-speed=60 で待機・反応の時間を 60 倍速にする（1 分が 1 秒）。
 * このときは確認用に window.__avatarBehavior から今の過ごし方を読み、身ぶりを呼べる
 */
function idleSpeed(): number {
  const speed = Number(new URL(location.href).searchParams.get('idle-speed'))
  return speed > 1 ? speed : 1
}

/** 台詞の場面ごとに合わせる、1回きりの動き（動きのファイルが割り当ててあれば再生する） */
const MOTION_FOR_SCENE: Partial<Record<Scene, MotionRole>> = {
  greetMorning: 'greet',
  greetDay: 'greet',
  greetEvening: 'greet',
  greetNight: 'greet',
  welcomeBack: 'greet',
  testsPassed: 'joy',
  headPat: 'joy',
}

/** 退屈したときの身ぶりを、動きのファイルの「気まぐれ」に置き換える確率 */
const PLAY_CHANCE = 0.4

function scaleReaction(timing: ReactionTiming, speed: number): ReactionTiming {
  return {
    cooldown: timing.cooldown / speed,
    touchCooldown: timing.touchCooldown / speed,
    longTask: timing.longTask / speed,
    absence: timing.absence / speed,
  }
}

/**
 * 会話していないときの過ごし方と、出来事への反応を動かす。
 * - 段階A：ひとりで過ごす（身ぶり・退屈・居眠り）。会話の出来事・アバターのクリックで目を覚ます
 * - 段階B：出来事（テストの結果・コマンドの失敗・長い作業・久しぶり・あいさつ）に台詞帳の一言で反応する
 */
export function useBehavior(
  getViewer: () => VrmViewer | null,
  connection: Ref<BridgeConnection>,
  /** モデルと動きのファイルを読み終えたか（あいさつは、その身ぶりが出せるようになってからする） */
  ready: Ref<boolean>,
) {
  const chat = useChatStore()
  const agents = useAgentsStore()
  const settings = useSettingsStore()
  const speed = idleSpeed()
  /** 設定（身ぶりの多さ・居眠りするか）に合わせた、ひとりで過ごすときの時間の決まり */
  const idleTiming = () => {
    const base = speed > 1 ? scaleTiming(DEFAULT_TIMING, speed) : DEFAULT_TIMING
    return timingForSettings(base, settings.idleGestures, settings.dozeEnabled)
  }
  watch(
    () => [settings.idleGestures, settings.dozeEnabled] as const,
    () => director?.setTiming(idleTiming()),
  )
  let director: BehaviorDirector | null = null
  let reactor: LineReactor | null = null
  let book: LineBook = DEFAULT_LINES
  let offActivity: (() => void) | null = null
  let reactorTimer: number | undefined

  /**
   * アバターをクリックした：体に当たったときだけ反応する（背景・吹き出し・ボタンは数えない）。
   * 居眠り中なら目を覚ます。起きていれば、頭はなでられてうなずき、体はつつかれて首をかしげる。
   * 台詞は間隔をあけて返すので、続けてクリックしたときは身ぶりだけで応える
   */
  const onTouch = (e: PointerEvent) => {
    // 右ボタンはカメラを回すのに使う
    if (e.button !== 0) return
    const viewer = getViewer()
    if (!director || !viewer) return
    const part = viewer.pick(e.clientX, e.clientY)
    if (!part) return
    const wasDozing = director.currentMood === 'dozing'
    director.activity('touch')
    if (wasDozing) return
    if (part === 'head') viewer.nod()
    else viewer.gesture('tilt')
    reactor?.onTouch(part)
  }

  // 選んでいるエージェントの台詞帳を読む（無ければ作る）
  watch(
    () => agents.current,
    async (agent) => {
      book = DEFAULT_LINES
      if (!agent) return
      const loaded = await loadLineBook(agent)
      if (agents.current?.id === agent.id) book = loaded
    },
    { immediate: true },
  )

  // Claude Code とつながり、モデルと動きのファイルを読み終えたら、時刻に合わせてあいさつする（画面を開いたとき1回だけ）
  const greetIfReady = () => {
    if (connection.value === 'connected' && ready.value) reactor?.greet()
  }
  watch([connection, ready], greetIfReady)

  /** ビューアができてから呼ぶ */
  function start() {
    const viewer = getViewer()
    if (!viewer || director) return
    reactor = new LineReactor(
      {
        say: (raw, scene) => {
          if (!chat.performReaction(raw)) return false
          const role = MOTION_FOR_SCENE[scene]
          if (role) viewer.playMotion(role)
          return true
        },
        book: () => book,
      },
      speed > 1 ? scaleReaction(DEFAULT_REACTION_TIMING, speed) : DEFAULT_REACTION_TIMING,
    )
    const r = reactor
    // 退屈したときの身ぶり（あくび・リズムに乗る）は、ときどき動きのファイルの「気まぐれ」に置き換える
    const body: IdleBody = {
      setMood: (mood) => viewer.setMood(mood),
      gesture: (g) => {
        if ((g === 'yawn' || g === 'groove') && viewer.hasMotion('play') && Math.random() < PLAY_CHANCE) viewer.playMotion('play')
        else viewer.gesture(g)
      },
      get isGesturing() {
        return viewer.isGesturing || viewer.isPlayingMotion
      },
    }
    director = new BehaviorDirector(
      body,
      () => chat.conversing,
      idleTiming(),
      {
        onWake: (kind) => {
          if (kind === 'touch') r.onWakeByTouch()
        },
        onMood: (mood) => r.onMood(mood),
      },
    )
    director.start()
    reactorTimer = window.setInterval(() => r.tick(), 1000)
    offActivity = chat.onActivity((event) => {
      // 反応の台詞を話し終えるのは出来事ではないので、会話の合図と自分の発言だけを数える
      director?.activity('conversation')
      r.onEvent(event)
    })
    viewer.canvas.addEventListener('pointerdown', onTouch)
    greetIfReady()
    if (speed > 1) {
      const d = director
      Object.assign(window, {
        __avatarBehavior: { mood: () => d.currentMood, gesture: (g: Gesture) => viewer.gesture(g), viewer, book: () => book },
      })
    }
  }

  onBeforeUnmount(() => {
    director?.stop()
    window.clearInterval(reactorTimer)
    offActivity?.()
    getViewer()?.canvas.removeEventListener('pointerdown', onTouch)
  })

  return { start }
}

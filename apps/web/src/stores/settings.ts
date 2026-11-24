import { defineStore } from 'pinia'
import { nextTick, ref, watch } from 'vue'
import { getSetting, setSetting, type CaptionMode, type IdleGestureLevel, type Settings } from '../db/settings'
import { stopSpeech } from '../voice/speech'
import { setAudioVolume } from '../voice/audio'
import { IS_COMPANION } from '../runtime'
import { laterDelay, withRetry } from '../retry'
import { initialTheme, setTheme, type ThemeChoice } from '../theme'

export const useSettingsStore = defineStore('settings', () => {
  /** 動画の背景を止める（小窓で重いとき。背景そのものはキャラクターごと） */
  const backgroundPaused = ref(false)
  /** 背景になじませる：足元の影の濃さと、背景の色を光に混ぜる強さ（すべてのキャラクターに効く） */
  const groundShadow = ref(0.5)
  const backdropLight = ref(0.5)
  /** 応答の読み上げ */
  const voiceEnabled = ref(true)
  /** Claude 連携モード。オンの間、アバターは Claude Code（同梱版は Claude Desktop のチャットも）との会話に反応する */
  const bridgeEnabled = ref(false)
  /** 吹き出しの出し方。小窓でアバターが隠れないよう、既定は最新のやり取りだけ */
  const captionMode = ref<CaptionMode>('latest')
  /** 声の音量（0〜1） */
  const volume = ref(1)
  /** 画面のテーマ。読み込むまでは、この端末に控えたものを使う（色がちらつかないように） */
  const theme = ref<ThemeChoice>(initialTheme())
  /** 会話していないときの身ぶりの多さと、居眠りするか */
  const idleGestures = ref<IdleGestureLevel>('normal')
  const dozeEnabled = ref(true)
  /** 会話の記録（同梱版）。記録は同梱サーバーが保存先フォルダに残す。既定はオフ */
  const conversationLog = ref(false)
  const conversationLogDays = ref(30)
  /** 放置中の逆提案（同梱版）と、話しかけるまでの時間（分）。既定はオフ */
  const proactiveEnabled = ref(false)
  const proactiveAfterMin = ref(5)
  /** 逆提案の材料に Claude Code のセッション記録（すべてのプロジェクトの最近のもの）も使うか（既定はオフ）と、読ませないフォルダ */
  const proactiveSessions = ref(false)
  const proactiveSessionExclude = ref<string[]>([])
  /** 保存した設定を読み終えたか（読み込みでの変化は、保存も知らせもしない） */
  const loaded = ref(false)

  /** 読めなかった設定の名前（読み込みのあとに知らせる。開発・試験用） */
  const unreadable = ref<string[]>([])

  /**
   * 設定を1つ読む。読めなかったら（保存先に一時的につながらないなど）間を空けて読み直し、それでもだめなら既定の値にする。
   * 1つ読めなくても、残りの設定は読み続ける（途中で止まると、残りがすべて既定の値のままになり、保存もされなくなる）
   */
  async function read<K extends keyof Settings>(key: K, fallback: Settings[K]): Promise<Settings[K]> {
    try {
      return (await withRetry(() => getSetting(key))) ?? fallback
    } catch {
      unreadable.value.push(key)
      return fallback
    }
  }

  /** 保存できなかった設定の名前（保存先に一時的につながらないなど） */
  const unsaved = ref<string[]>([])
  /** 保存できなかった設定の、最後に頼まれた値（あとで保存し直す） */
  const pending = new Map<keyof Settings, unknown>()
  /** 設定ごとの、最後に頼まれた保存の番号（古い値のやり直しで、新しい値を上書きしない） */
  const latestSave = new Map<keyof Settings, number>()
  let saveCount = 0
  let resaveTimer: ReturnType<typeof setTimeout> | null = null
  /** 続けて保存し直しに失敗した回数 */
  let resaveFailures = 0

  /**
   * 設定を1つ保存する。保存できなかったら間を空けてやり直し、それでもだめなら名前を控えて知らせ、あとで保存し直す（黙って失わない）。
   * やり直している間に同じ設定が変わったら、古い値はやめる
   */
  async function save<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    const mine = ++saveCount
    latestSave.set(key, mine)
    // あとで保存し直す予定の古い値は捨てる（あとから古い値で上書きしないように）
    pending.delete(key)
    const isLatest = () => latestSave.get(key) === mine
    try {
      await withRetry(() => setSetting(key, value), isLatest)
      if (!isLatest()) return
      pending.delete(key)
      unsaved.value = unsaved.value.filter((k) => k !== key)
      if (unsaved.value.length === 0) resaveFailures = 0
    } catch {
      if (!isLatest()) return
      pending.set(key, value)
      if (!unsaved.value.includes(key)) unsaved.value.push(key)
      resaveLater()
    }
  }

  /** 保存できなかった設定を、少したってから保存し直す */
  function resaveLater() {
    if (resaveTimer) return
    // 失敗が続くほど間を空ける（保存先が止まったままのとき、試し続けないように）
    resaveTimer = setTimeout(() => {
      resaveTimer = null
      for (const [key, value] of pending) void save(key, value as never)
    }, laterDelay(resaveFailures++))
  }

  async function load() {
    try {
      // 設定はまとめて同時に読む（1 つずつ読むと、読めない状態が続いたとき、やり直しの待ちが設定の数だけ重なる）
      const [
        rBackgroundPaused,
        rGroundShadow,
        rBackdropLight,
        rVoiceEnabled,
        rBridgeEnabled,
        rCaptionMode,
        rVolume,
        rTheme,
        rIdleGestures,
        rDozeEnabled,
        rConversationLog,
        rConversationLogDays,
        rProactiveEnabled,
        rProactiveAfterMin,
        rProactiveSessions,
        rProactiveSessionExclude,
      ] = await Promise.all([
        read('backgroundPaused', false),
        read('groundShadow', 0.5),
        read('backdropLight', 0.5),
        read('voiceEnabled', true),
        // 同梱版は Claude 連携のための画面なので、常にオン（読まない）
        IS_COMPANION ? Promise.resolve(true) : read('bridgeEnabled', false),
        read('captionMode', 'latest'),
        read('volume', 1),
        read('theme', initialTheme()),
        read('idleGestures', 'normal'),
        read('dozeEnabled', true),
        read('conversationLog', false),
        read('conversationLogDays', 30),
        read('proactiveEnabled', false),
        read('proactiveAfterMin', 5),
        read('proactiveSessions', false),
        read('proactiveSessionExclude', []),
      ])
      backgroundPaused.value = rBackgroundPaused
      groundShadow.value = rGroundShadow
      backdropLight.value = rBackdropLight
      voiceEnabled.value = rVoiceEnabled
      bridgeEnabled.value = rBridgeEnabled
      captionMode.value = rCaptionMode
      volume.value = rVolume
      theme.value = rTheme
      idleGestures.value = rIdleGestures
      dozeEnabled.value = rDozeEnabled
      conversationLog.value = rConversationLog
      conversationLogDays.value = rConversationLogDays
      proactiveEnabled.value = rProactiveEnabled
      proactiveAfterMin.value = rProactiveAfterMin
      proactiveSessions.value = rProactiveSessions
      proactiveSessionExclude.value = rProactiveSessionExclude
    } finally {
      // 読んだ値を入れたことによる変更は保存しない（読めずに既定の値にした設定で、保存されている値を上書きしないように）。
      // 変更を見張る処理は少し遅れて動くので、それが済んでから「読み終えた」にする。以後の変更は保存する
      await nextTick()
      loaded.value = true
    }
  }

  watch(
    volume,
    (value) => {
      setAudioVolume(value)
      if (loaded.value) void save('volume', value)
    },
    { immediate: true },
  )

  watch(theme, (value) => {
    setTheme(value)
    if (loaded.value) void save('theme', value)
  })

  watch(idleGestures, (value) => {
    if (loaded.value) void save('idleGestures', value)
  })

  watch(dozeEnabled, (value) => {
    if (loaded.value) void save('dozeEnabled', value)
  })

  watch(conversationLog, (value) => {
    if (loaded.value) void save('conversationLog', value)
  })

  watch(conversationLogDays, (value) => {
    if (loaded.value) void save('conversationLogDays', value)
  })

  watch(proactiveEnabled, (value) => {
    if (loaded.value) void save('proactiveEnabled', value)
  })

  watch(proactiveSessions, (value) => {
    if (loaded.value) void save('proactiveSessions', value)
  })

  watch(proactiveSessionExclude, (value) => {
    if (loaded.value) void save('proactiveSessionExclude', [...value])
  })

  watch(proactiveAfterMin, (value) => {
    if (loaded.value) void save('proactiveAfterMin', value)
  })

  watch(captionMode, (value) => {
    if (loaded.value) void save('captionMode', value)
  })

  watch(bridgeEnabled, (value) => {
    if (loaded.value) void save('bridgeEnabled', value)
  })

  watch(backgroundPaused, (value) => {
    if (loaded.value) void save('backgroundPaused', value)
  })

  watch(groundShadow, (value) => {
    if (loaded.value) void save('groundShadow', value)
  })

  watch(backdropLight, (value) => {
    if (loaded.value) void save('backdropLight', value)
  })

  watch(voiceEnabled, (value) => {
    // オフにしたら読み上げ中のものも止める（文字送りと口パクはそのまま続く）
    if (!value) stopSpeech()
    if (loaded.value) void save('voiceEnabled', value)
  })

  return {
    backgroundPaused,
    groundShadow,
    backdropLight,
    voiceEnabled,
    bridgeEnabled,
    captionMode,
    volume,
    theme,
    idleGestures,
    dozeEnabled,
    conversationLog,
    conversationLogDays,
    proactiveEnabled,
    proactiveAfterMin,
    proactiveSessions,
    proactiveSessionExclude,
    loaded,
    unreadable,
    unsaved,
    load,
  }
})

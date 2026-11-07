import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { getSetting, setSetting, type CaptionMode, type IdleGestureLevel } from '../db/settings'
import { stopSpeech } from '../voice/speech'
import { setAudioVolume } from '../voice/audio'
import { IS_COMPANION } from '../runtime'
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
  /** 保存した設定を読み終えたか（読み込みでの変化は、保存も知らせもしない） */
  const loaded = ref(false)

  async function load() {
    backgroundPaused.value = (await getSetting('backgroundPaused')) ?? false
    groundShadow.value = (await getSetting('groundShadow')) ?? 0.5
    backdropLight.value = (await getSetting('backdropLight')) ?? 0.5
    voiceEnabled.value = (await getSetting('voiceEnabled')) ?? true
    // 同梱版は Claude 連携のための画面なので、常にオン
    bridgeEnabled.value = IS_COMPANION || ((await getSetting('bridgeEnabled')) ?? false)
    captionMode.value = (await getSetting('captionMode')) ?? 'latest'
    volume.value = (await getSetting('volume')) ?? 1
    theme.value = (await getSetting('theme')) ?? initialTheme()
    idleGestures.value = (await getSetting('idleGestures')) ?? 'normal'
    dozeEnabled.value = (await getSetting('dozeEnabled')) ?? true
    loaded.value = true
  }

  watch(
    volume,
    (value) => {
      setAudioVolume(value)
      if (loaded.value) void setSetting('volume', value)
    },
    { immediate: true },
  )

  watch(theme, (value) => {
    setTheme(value)
    if (loaded.value) void setSetting('theme', value)
  })

  watch(idleGestures, (value) => {
    if (loaded.value) void setSetting('idleGestures', value)
  })

  watch(dozeEnabled, (value) => {
    if (loaded.value) void setSetting('dozeEnabled', value)
  })

  watch(captionMode, (value) => {
    if (loaded.value) void setSetting('captionMode', value)
  })

  watch(bridgeEnabled, (value) => {
    if (loaded.value) void setSetting('bridgeEnabled', value)
  })

  watch(backgroundPaused, (value) => {
    if (loaded.value) void setSetting('backgroundPaused', value)
  })

  watch(groundShadow, (value) => {
    if (loaded.value) void setSetting('groundShadow', value)
  })

  watch(backdropLight, (value) => {
    if (loaded.value) void setSetting('backdropLight', value)
  })

  watch(voiceEnabled, (value) => {
    // オフにしたら読み上げ中のものも止める（文字送りと口パクはそのまま続く）
    if (!value) stopSpeech()
    if (loaded.value) void setSetting('voiceEnabled', value)
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
    loaded,
    load,
  }
})

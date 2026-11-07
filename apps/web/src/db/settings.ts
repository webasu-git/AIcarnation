import { idbGet, idbPut } from './idb'
import type { ThemeChoice } from '../theme'

export interface Settings {
  currentAgentId: string
  /** 動画の背景を止める（小窓で重いとき） */
  backgroundPaused: boolean
  /** 足元の影の濃さ（0〜1） */
  groundShadow: number
  /** 背景の色をアバターの光に混ぜる強さ（0〜1） */
  backdropLight: number
  voiceEnabled: boolean
  bridgeEnabled: boolean
  captionMode: CaptionMode
  /** 画面のテーマ（システム＝ブラウザ・OS に合わせる／ライト／ダーク） */
  theme: ThemeChoice
  /** 声の音量（0〜1） */
  volume: number
  /** 会話していないときの身ぶりの多さ */
  idleGestures: IdleGestureLevel
  /** 長く話しかけないと居眠りするか */
  dozeEnabled: boolean
}

/** 会話していないときの身ぶりの多さ：多め／ふつう／少なめ／しない */
export type IdleGestureLevel = 'more' | 'normal' | 'less' | 'off'

/** 吹き出しの出し方：最新のやり取りだけ／直近すべて／出さない */
export type CaptionMode = 'latest' | 'all' | 'off'

interface SettingRecord<K extends keyof Settings> {
  key: K
  value: Settings[K]
}

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K] | undefined> {
  const record = await idbGet<SettingRecord<K>>('settings', key)
  return record?.value
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await idbPut<SettingRecord<K>>('settings', { key, value })
}

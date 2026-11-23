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
  /** 会話（発言と返事）を手元に記録するか（同梱版。放置中の逆提案の材料。既定はオフ） */
  conversationLog: boolean
  /** 会話の記録を残す日数 */
  conversationLogDays: number
  /** 放置中に、アバターから続きを提案するか（同梱版。会話の記録が要る。既定はオフ） */
  proactiveEnabled: boolean
  /** 話しかけるまでの放置の時間（分） */
  proactiveAfterMin: number
  /** 逆提案の材料に、Claude Code のセッション記録（発言と最後の返事）も使うか（既定はオフ） */
  proactiveSessions: boolean
  /** セッション記録を読ませないプロジェクトのフォルダ（とその下。書かなければ、すべてのプロジェクトの最近の記録を見る） */
  proactiveSessionExclude: string[]
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

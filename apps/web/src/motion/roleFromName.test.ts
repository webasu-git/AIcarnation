import { describe, expect, it } from 'vitest'
import { isMotionFileName, roleFromFileName } from './roleFromName'

describe('roleFromFileName（ファイル名の先頭の印から動きの役を決める）', () => {
  it('かっこで囲んだ印を読む（半角・全角・隅付き）', () => {
    expect(roleFromFileName('(待機)Happy Idle.fbx')).toBe('idle')
    expect(roleFromFileName('（考える）Thinking.fbx')).toBe('thinking')
    expect(roleFromFileName('【挨拶】Standing Greeting.fbx')).toBe('greet')
    expect(roleFromFileName('[作業中]Entering Code.fbx')).toBe('working')
    expect(roleFromFileName('(話す)Talking1.fbx')).toBe('talking')
    expect(roleFromFileName('(喜ぶ)Clapping.fbx')).toBe('joy')
    expect(roleFromFileName('(気まぐれ)Yawn.fbx')).toBe('play')
  })

  it('区切り文字の前の印や、英語の印も読む', () => {
    expect(roleFromFileName('待機_Idle.vrma')).toBe('idle')
    expect(roleFromFileName('greet-wave.vrma')).toBe('greet')
    expect(roleFromFileName('IDLE Breathing.fbx')).toBe('idle')
  })

  it('印が無い・知らない言葉なら null', () => {
    expect(roleFromFileName('TextingWhileStanding.fbx')).toBeNull()
    expect(roleFromFileName('(ダンス)Hiphop.fbx')).toBeNull()
    expect(roleFromFileName('Idle.fbx')).toBeNull()
  })

  it('動きのファイルの拡張子だけを受け付ける', () => {
    expect(isMotionFileName('a.FBX')).toBe(true)
    expect(isMotionFileName('a.vrma')).toBe(true)
    expect(isMotionFileName('a.vrm')).toBe(false)
    expect(isMotionFileName('readme.txt')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE, NO_VRM, type AgentDefinition } from '@aicarnation/shared'
import { makeCharacterFile, parseCharacterFile, pruneMissing, resolveVoice } from './characterFile'

const agent: AgentDefinition = {
  id: 'a1',
  name: 'テスト役',
  firstPerson: '僕',
  tone: '〜ですね',
  personality: '好奇心が強い',
  background: '図書館で働いていた',
  topics: ['読書'],
  forbidden: ['敬語'],
  systemPrompt: 'あなたはテスト役です。',
  appearance: '',
  vrm: { source: 'local', ref: 'vrm-file-id' },
  voice: { ...DEFAULT_VOICE, voiceURI: 'engine:aivis:111', rate: 1.1, intonation: 1.2 },
  motions: { idle: [{ fileId: 'f1', name: '(待機)Idle.fbx' }], greet: [{ fileId: 'f2', name: 'Wave.fbx' }] },
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
}

const styles = [
  { styleId: 111, speaker: 'テスト役', style: 'ノーマル' },
  { styleId: 222, speaker: 'まお', style: 'ノーマル' },
]

describe('キャラクターの書き出しファイル', () => {
  it('設定だけを書き出す（ファイルの id・VRM・動きのファイルそのものは入れず、名前だけ）', () => {
    const file = makeCharacterFile(agent, { vrmFileName: 'character.vrm', engineStyle: styles[0]!, dictionary: [] }, new Date('2026-10-26T00:00:00Z'))
    expect(file.character.name).toBe('テスト役')
    expect(file.vrmFileName).toBe('character.vrm')
    expect(file.motions).toEqual([
      { role: 'idle', name: '(待機)Idle.fbx' },
      { role: 'greet', name: 'Wave.fbx' },
    ])
    expect(file.voice).toMatchObject({ rate: 1.1, intonation: 1.2, speaker: 'テスト役', style: 'ノーマル' })
    const text = JSON.stringify(file)
    expect(text).not.toContain('vrm-file-id')
    expect(text).not.toContain('"f1"')
    expect(parseCharacterFile(JSON.parse(text))).toEqual(file)
  })

  it('形が違うファイルは理由を付けて断る', () => {
    const file = makeCharacterFile(agent, { vrmFileName: null, engineStyle: null, dictionary: [] })
    expect(() => parseCharacterFile({ ...file, format: 'other' })).toThrow('書き出しファイルではありません')
    expect(() => parseCharacterFile({ ...file, character: { ...file.character, name: ' ' } })).toThrow('名前が空')
    expect(() => parseCharacterFile({ ...file, motions: [{ role: 'idle' }] })).toThrow('動きの割り当て')
  })

  it('声は、同じ話者・スタイルが入っていればそれを使い、無ければブラウザの声にして要る声を返す', () => {
    const file = makeCharacterFile(agent, { vrmFileName: null, engineStyle: styles[0]!, dictionary: [] })
    const found = resolveVoice(file.voice, [{ styleId: 999, speaker: 'テスト役', style: 'ノーマル' }])
    expect(found.voice.voiceURI).toBe('engine:aivis:999')
    expect(found.missing).toBeUndefined()
    const notFound = resolveVoice(file.voice, [styles[1]!])
    expect(notFound.voice.voiceURI).toBe('')
    expect(notFound.voice.rate).toBe(1.1)
    expect(notFound.missing).toEqual({ speaker: 'テスト役', style: 'ノーマル' })
  })

  it('背景は単色の色か、画像・動画のファイル名と見せ方だけを書き出す', () => {
    const backdrop = {
      kind: 'image' as const,
      fileId: 'bg-file-id',
      name: 'room.jpg',
      media: 'image' as const,
      focusX: 0.3,
      focusY: 0.5,
      zoom: 1.2,
      brightness: 0.8,
      blur: 2,
      parallax: true,
    }
    const file = makeCharacterFile({ ...agent, backdrop }, { vrmFileName: null, engineStyle: null, dictionary: [] })
    expect(file.backdrop).toEqual({ kind: 'image', name: 'room.jpg', media: 'image', focusX: 0.3, focusY: 0.5, zoom: 1.2, brightness: 0.8, blur: 2, parallax: true })
    expect(JSON.stringify(file)).not.toContain('bg-file-id')
    expect(parseCharacterFile(JSON.parse(JSON.stringify(file))).backdrop).toEqual(file.backdrop)
    expect(() => parseCharacterFile({ ...file, backdrop: { kind: 'video' } })).toThrow('背景の形')
    expect(pruneMissing({ ...agent, missing: { backgroundFileName: 'room.jpg' }, backdrop })).toBeUndefined()
  })

  it('素材を入れたら、足りないものの一覧から消える', () => {
    const imported: AgentDefinition = {
      ...agent,
      vrm: NO_VRM,
      voice: DEFAULT_VOICE,
      motions: {},
      missing: {
        vrmFileName: 'character.vrm',
        motions: [
          { role: 'idle', name: '(待機)Idle.fbx' },
          { role: 'greet', name: 'Wave.fbx' },
        ],
        voice: { speaker: 'テスト役', style: 'ノーマル' },
      },
    }
    expect(pruneMissing(imported)).toEqual(imported.missing)
    const someDone = { ...imported, motions: { greet: [{ fileId: 'x', name: 'Wave.fbx' }] }, vrm: { source: 'local' as const, ref: 'v' } }
    expect(pruneMissing(someDone)).toEqual({ motions: [{ role: 'idle', name: '(待機)Idle.fbx' }], voice: imported.missing!.voice })
    const allDone = { ...someDone, motions: agent.motions, voice: agent.voice }
    expect(pruneMissing(allDone)).toBeUndefined()
  })

  it('アイコンは画像のファイル名と位置・拡大だけを書き出し、動きの切り替えは切ったときだけ書く', () => {
    const withIcon: AgentDefinition = { ...agent, icon: { fileId: 'icon-id', name: 'face.png', x: 0.4, y: 0.3, zoom: 1.5 }, talkGestures: false }
    const file = makeCharacterFile(withIcon, { vrmFileName: null, engineStyle: null, dictionary: [] })
    expect(file.icon).toEqual({ name: 'face.png', x: 0.4, y: 0.3, zoom: 1.5 })
    expect(file.talkGestures).toBe(false)
    expect(file.steadyWaist).toBeUndefined()
    expect(JSON.stringify(file)).not.toContain('icon-id')
    expect(parseCharacterFile(JSON.parse(JSON.stringify(file))).icon?.name).toBe('face.png')
    expect(() => parseCharacterFile({ ...file, icon: { name: 1 } })).toThrow('アイコン')
  })

  it('足りないアイコンは、アイコンの画像を入れると一覧から消える', () => {
    const missing = { icon: { name: 'face.png', x: 0.5, y: 0.5, zoom: 1 } }
    expect(pruneMissing({ ...agent, missing })).toEqual(missing)
    expect(pruneMissing({ ...agent, missing, icon: { fileId: 'x', name: 'face.png', x: 0.5, y: 0.5, zoom: 1 } })).toBeUndefined()
  })
})

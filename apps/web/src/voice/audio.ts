/**
 * 音声エンジンの声の再生と、いま鳴っている音の大きさの計測（口の開き具合に使う）。
 * ブラウザは操作する前の音の再生を止めるので、最初の操作で unlockAudio() を呼んでおく
 */
let context: AudioContext | null = null
/** 声の音量のつまみ。すべての再生がここを通る */
let master: GainNode | null = null
/** 音量（0〜1）。AudioContext を作る前に設定されたときのために覚えておく */
let volume = 1

function audioContext(): AudioContext {
  context ??= new AudioContext()
  return context
}

function masterGain(c: AudioContext): GainNode {
  if (!master) {
    master = c.createGain()
    master.gain.value = volume
    master.connect(c.destination)
  }
  return master
}

/** 声の音量（0〜1）を変える。再生中の声にもすぐ効く */
export function setAudioVolume(value: number): void {
  volume = Math.min(1, Math.max(0, value))
  if (master && context) master.gain.setTargetAtTime(volume, context.currentTime, 0.02)
}

export function getAudioVolume(): number {
  return volume
}

/** クリックやキー操作のたびに呼ぶ。止められていた音の再生を許可する */
export function unlockAudio(): void {
  const c = audioContext()
  if (c.state === 'suspended') void c.resume().catch(() => undefined)
}

export interface Playback {
  /** 音声の長さ（秒） */
  duration: number
  /** 再生を始めた時刻（performance.now() の値） */
  startedAt: number
  /** いま鳴っている音の大きさ（0〜1 程度） */
  level(): number
  ended: Promise<void>
  stop(): void
}

/** WAV などの音声を再生する。再生を許可されていないときは例外 */
export async function playAudio(data: ArrayBuffer): Promise<Playback> {
  const c = audioContext()
  if (c.state === 'suspended') await c.resume().catch(() => undefined)
  if (c.state !== 'running') throw new Error('音の再生が許可されていません')

  const buffer = await c.decodeAudioData(data)
  const source = c.createBufferSource()
  source.buffer = buffer
  const analyser = c.createAnalyser()
  analyser.fftSize = 512
  // 口の開き具合は音量に左右されないよう、音量のつまみの手前で音の大きさを測る
  source.connect(analyser)
  analyser.connect(masterGain(c))

  const samples = new Float32Array(analyser.fftSize)
  let finish!: () => void
  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })
  source.onended = () => finish()
  source.start()

  return {
    duration: buffer.duration,
    startedAt: performance.now(),
    level() {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const v of samples) sum += v * v
      return Math.sqrt(sum / samples.length)
    },
    ended,
    stop() {
      try {
        source.stop()
      } catch {
        // もう止まっている
      }
      finish()
    },
  }
}

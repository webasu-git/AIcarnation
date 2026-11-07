// Web Speech API の音声認識。TypeScript の lib.dom にはイベントの型しか無いため、本体を自前で定義する
interface SpeechRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition
}

interface Window {
  readonly SpeechRecognition?: SpeechRecognitionConstructor
  readonly webkitSpeechRecognition?: SpeechRecognitionConstructor
}

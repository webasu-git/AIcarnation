function recognitionClass(): SpeechRecognitionConstructor | undefined {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition
}

export function isRecognitionSupported(): boolean {
  return recognitionClass() !== undefined
}

/** ブラウザの言語が分からないときの音声入力の言語 */
const FALLBACK_LANG = 'ja-JP'

/** 音声入力の言語は、使っているブラウザの言語（いちばん好みの言語）に合わせる */
export function recognitionLangFrom(languages: readonly string[] | undefined, language?: string): string {
  return languages?.find((l) => l.trim()) ?? (language?.trim() || FALLBACK_LANG)
}

export function browserRecognitionLang(): string {
  return recognitionLangFrom(navigator.languages, navigator.language)
}

export interface RecognitionHandlers {
  /** 話している途中の暫定の文字 */
  onInterim(text: string): void
  /** 確定した文。そのまま送信する */
  onFinal(text: string): void
  onError(message: string): void
  /** 認識が終わった（確定・エラー・停止のいずれでも呼ぶ） */
  onEnd(): void
}

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'マイクの使用が許可されていません',
  'service-not-allowed': 'このブラウザでは音声入力をご利用いただけません',
  'no-speech': '聞き取れませんでした',
  'audio-capture': 'マイクが見つかりません',
  network: '音声認識の通信に失敗しました',
}

/**
 * マイクで1文を聞き取る。確定したら onFinal を呼んで終わる。
 * 返り値の stop() で途中でやめられる
 */
export function startRecognition(lang: string, handlers: RecognitionHandlers): { stop(): void } {
  const Recognition = recognitionClass()
  if (!Recognition) {
    handlers.onError('このブラウザは音声入力に対応していません')
    handlers.onEnd()
    return { stop() {} }
  }
  const recognition = new Recognition()
  recognition.lang = lang
  recognition.continuous = false
  recognition.interimResults = true
  recognition.maxAlternatives = 1

  recognition.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const text = result?.[0]?.transcript ?? ''
      if (result?.isFinal) {
        if (text.trim()) handlers.onFinal(text.trim())
      } else {
        interim += text
      }
    }
    if (interim) handlers.onInterim(interim)
  }
  recognition.onerror = (event) => {
    // 自分で止めたときの aborted は知らせない
    if (event.error !== 'aborted') handlers.onError(ERROR_MESSAGES[event.error] ?? `音声入力に失敗しました（${event.error}）`)
  }
  recognition.onend = () => handlers.onEnd()

  try {
    recognition.start()
  } catch {
    handlers.onError('音声入力を開始できませんでした')
    handlers.onEnd()
  }
  return { stop: () => recognition.abort() }
}

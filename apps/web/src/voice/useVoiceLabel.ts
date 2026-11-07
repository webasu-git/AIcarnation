import { computed, ref, watch, type Ref } from 'vue'
import { cachedEngineStyles, engineStatus, parseEngineVoiceURI } from './engines'

/**
 * 声の設定（voiceURI）を、人が読める名前にする。
 * AivisSpeech の声は話者の一覧から「話者（スタイル）」を引き、ブラウザの声は声の名前（無ければ既定の声）
 */
export function useVoiceLabel(voiceURI: () => string): { label: Ref<string>; isEngine: Ref<boolean> } {
  const speaker = ref('')
  watch(
    () => [voiceURI(), engineStatus.aivis] as const,
    async ([uri]) => {
      const engine = parseEngineVoiceURI(uri)
      if (!engine) return (speaker.value = '')
      const style = (await cachedEngineStyles(engine.engine)).find((s) => s.styleId === engine.styleId)
      speaker.value = style ? `${style.speaker}（${style.style}）` : ''
    },
    { immediate: true },
  )
  const isEngine = computed(() => parseEngineVoiceURI(voiceURI()) !== null)
  const label = computed(() => {
    if (isEngine.value) return `AivisSpeech${speaker.value ? `・${speaker.value}` : ''}`
    const uri = voiceURI()
    if (!uri) return 'ブラウザの既定の声'
    const voice = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices().find((v) => v.voiceURI === uri) : undefined
    return `ブラウザの声・${voice?.name ?? uri}`
  })
  return { label, isEngine }
}

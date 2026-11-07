// Document Picture-in-Picture API（Chrome / Edge 116+）。TypeScript の lib.dom にまだ無いため自前で定義する
interface DocumentPictureInPictureOptions {
  width?: number
  height?: number
  disallowReturnToOpener?: boolean
}

interface DocumentPictureInPicture extends EventTarget {
  readonly window: Window | null
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>
}

interface Window {
  readonly documentPictureInPicture?: DocumentPictureInPicture
}

// Safari の旧来の動画PiP API
interface HTMLVideoElement {
  webkitSupportsPresentationMode?: (mode: string) => boolean
  webkitSetPresentationMode?: (mode: 'inline' | 'picture-in-picture' | 'fullscreen') => void
  readonly webkitPresentationMode?: string
}

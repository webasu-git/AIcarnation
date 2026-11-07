// 非表示タブでも間引かれにくい Worker のタイマーで描画の合図を送る（動画PiP用）
let timer: ReturnType<typeof setInterval> | undefined

self.onmessage = (e: MessageEvent<{ fps: number } | 'stop'>) => {
  clearInterval(timer)
  timer = undefined
  if (e.data === 'stop') return
  timer = setInterval(() => self.postMessage(0), 1000 / e.data.fps)
}

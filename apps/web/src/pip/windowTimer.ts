/**
 * 小窓（Document PiP）の window で回すタイマー。
 * 小窓が開いている間は、本体のタブが裏に回ってもタイマーが遅れないよう、小窓の window で回す。
 * ただし閉じた小窓の window のタイマーは二度と動かないので、閉じられたら（pagehide）残りの時間を本体の window で回す
 * （待っている処理が終わらず、声や反応が止まったままにならないように）。
 * 返す関数を呼ぶと取り消す（どちらの window で回していても取り消せる）
 */
export function setWindowTimeout(
  win: Window,
  fn: () => void,
  ms: number,
  // 本体の window（ブラウザでは globalThis が window。試験の環境でも動くよう globalThis で受ける）
  main: Window = globalThis as unknown as Window,
): () => void {
  if (win === main || win.closed) {
    const id = main.setTimeout(fn, ms)
    return () => main.clearTimeout(id)
  }
  const due = Date.now() + ms
  let fallback: number | undefined
  const onHide = () => {
    win.clearTimeout(id)
    fallback = main.setTimeout(fn, Math.max(0, due - Date.now()))
  }
  const id = win.setTimeout(() => {
    win.removeEventListener('pagehide', onHide)
    fn()
  }, ms)
  win.addEventListener('pagehide', onHide, { once: true })
  return () => {
    win.clearTimeout(id)
    main.clearTimeout(fallback)
    win.removeEventListener('pagehide', onHide)
  }
}

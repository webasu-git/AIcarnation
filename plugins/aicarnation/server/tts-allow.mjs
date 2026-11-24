/**
 * 音声エンジンへ中継してよい呼び出し（画面が使うものだけ）。メソッドとパス（クエリを除く）で決める。
 * エンジンのほかの API（設定の変更など）は通さない
 */
const TTS_ALLOWED = [
  ['GET', /^\/version$/],
  ['GET', /^\/speakers$/],
  ['GET', /^\/aivm_models$/],
  ['POST', /^\/aivm_models\/install$/],
  ['DELETE', /^\/aivm_models\/[0-9a-fA-F-]{1,64}\/uninstall$/],
  ['POST', /^\/audio_query$/],
  ['POST', /^\/synthesis$/],
  ['GET', /^\/user_dict$/],
  ['POST', /^\/user_dict_word$/],
  ['PUT', /^\/user_dict_word\/[0-9a-fA-F-]{1,64}$/],
  ['DELETE', /^\/user_dict_word\/[0-9a-fA-F-]{1,64}$/],
]

/** 中継してよい呼び出しか */
export function ttsAllowed(method, path) {
  return TTS_ALLOWED.some(([m, re]) => m === method && re.test(path))
}

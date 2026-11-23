// フォルダを選ぶ窓（OS のもの）を開いて、選ばれたフォルダのパスを返す。
// ブラウザの画面からは、選んだフォルダの場所（パス）を知ることができないので、同じ PC で動いているサーバーが窓を開く。
// 窓を開くだけで、選ぶのは利用者。選ばなければ null を返す
import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** 窓を開いたまま待つ時間の上限 */
const PICK_TIMEOUT_MS = 5 * 60_000

/** Windows：フォルダを選ぶ窓を、ほかの窓の手前に出す。選んだパスを UTF-8 で書き出す */
const WINDOWS_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$owner.ShowInTaskbar = $false',
  '$owner.Opacity = 0',
  '$owner.Show()',
  '$owner.Activate()',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$dialog.Description = $env:AICARNATION_PICK_PROMPT',
  '$dialog.ShowNewFolderButton = $false',
  '$result = $dialog.ShowDialog($owner)',
  '$owner.Close()',
  "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Out.Write($dialog.SelectedPath) }",
].join('; ')

/** macOS：フォルダを選ぶ窓。やめると osascript が失敗で終わる */
const MAC_SCRIPT = 'POSIX path of (choose folder with prompt (system attribute "AICARNATION_PICK_PROMPT"))'

/** この OS で窓を開くコマンド。対応していなければ null。システムのものを名指しする（いまのフォルダに置かれた同名のものを動かさない） */
export function pickCommand(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const powershell = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return { file: powershell, args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_SCRIPT] }
  }
  if (platform === 'darwin') return { file: '/usr/bin/osascript', args: ['-e', MAC_SCRIPT] }
  return null
}

/** コマンドの出力から、選ばれたフォルダのパスを取り出す（末尾の改行と区切りを落とす）。選ばれていなければ null */
export function parsePicked(stdout) {
  const path = String(stdout ?? '').trim()
  if (!path) return null
  // ドライブの直下（C:\）やルート（/）は、区切りを残す
  return /^([A-Za-z]:[\\/]|\/)$/.test(path) ? path : path.replace(/[\\/]+$/, '')
}

/** 窓は同時に1つだけ開く */
let picking = false

/**
 * フォルダを選ぶ窓を開く。{ path } か { path: null }（選ばなかった）、
 * 対応していない OS・もう開いているときは { error } を返す
 */
export function pickFolder(prompt, run = execFile) {
  const command = pickCommand()
  if (!command) return Promise.resolve({ error: 'この OS では、フォルダを選ぶ窓を開けません' })
  if (picking) return Promise.resolve({ error: 'フォルダを選ぶ窓が、もう開いています' })
  picking = true
  return new Promise((resolve) => {
    run(
      command.file,
      command.args,
      { timeout: PICK_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', env: { ...process.env, AICARNATION_PICK_PROMPT: String(prompt).slice(0, 200) } },
      (err, stdout) => {
        picking = false
        // やめたとき（macOS は失敗で終わる）も、選ばなかったものとして扱う
        resolve({ path: err ? null : parsePicked(stdout) })
      },
    )
  })
}

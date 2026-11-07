import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { posix } from 'node:path'
import type { Plugin } from 'vite'

const { dirname, join } = posix

/**
 * ビルドした画面に入った外部ライブラリのライセンス文を集めて、THIRD_PARTY_NOTICES.txt として画面と一緒に出す。
 * MIT などは「ライセンス文を一緒に配ること」が条件で、ビルドすると元のファイルの表記が消えるため。
 * 実際にまとめた部品（node_modules の下のモジュール）だけを見るので、使っていない依存は入らない
 */
export function thirdPartyNotices(): Plugin {
  return {
    name: 'aicarnation-third-party-notices',
    apply: 'build',
    generateBundle() {
      const roots = new Set<string>()
      for (const id of this.getModuleIds()) {
        // Vite は Windows でもモジュールの場所を / 区切りで渡すことがあるので、/ にそろえて見る
        const file = id.split('?')[0]!.replace(/^\0/, '').replaceAll('\\', '/')
        if (!file.includes('/node_modules/')) continue
        const root = packageRoot(file)
        if (root) roots.add(root)
      }
      const entries = [...roots]
        .map(readPackage)
        .filter((p): p is PackageNotice => p !== null)
        .sort((a, b) => a.name.localeCompare(b.name))
      // 同じ名前・版は1つにまとめる
      const seen = new Set<string>()
      const unique = entries.filter((p) => !seen.has(`${p.name}@${p.version}`) && seen.add(`${p.name}@${p.version}`))
      const text = [
        'AIcarnation の画面には、次の外部ライブラリが含まれています。それぞれのライセンス文を掲載します。',
        'This UI bundles the following third-party libraries. Their license notices follow.',
        '',
        ...unique.flatMap((p) => ['='.repeat(72), `${p.name} ${p.version} (${p.license})`, '-'.repeat(72), p.text.trim(), '']),
      ].join('\n')
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: text })
    },
  }
}

interface PackageNotice {
  name: string
  version: string
  license: string
  text: string
}

/** ファイルから上へたどって、package.json に name がある最初のフォルダ（そのパッケージの根元） */
function packageRoot(file: string): string | null {
  let dir = dirname(file)
  while (dir.includes('/node_modules/')) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name) return dir
      } catch {
        // 読めない package.json は飛ばして上へ
      }
    }
    dir = dirname(dir)
  }
  return null
}

function readPackage(root: string): PackageNotice | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string; license?: string }
    if (!pkg.name) return null
    const file = readdirSync(root).find((f) => /^(license|licence|copying)(\.|$)/i.test(f))
    const text = file ? readFileSync(join(root, file), 'utf8') : `License: ${pkg.license ?? 'unknown'} (no license file in the package)`
    return { name: pkg.name, version: pkg.version ?? '', license: pkg.license ?? 'unknown', text }
  } catch {
    return null
  }
}

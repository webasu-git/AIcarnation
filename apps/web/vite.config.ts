/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { aicarnationDevBridge } from './bridge/vitePlugin'
import { thirdPartyNotices } from './bridge/thirdPartyNotices'
import { isCrossSite } from './bridge/sameOrigin'

const DEV_PORT = 5173
/** 画面に出す版の番号。開発版を入れ直すときは、環境変数 AICARNATION_VERSION で開発版の番号を渡す */
const pluginManifest = JSON.parse(readFileSync(new URL('../../plugins/aicarnation/.claude-plugin/plugin.json', import.meta.url), 'utf8')) as { version: string }
const APP_VERSION = process.env.AICARNATION_VERSION || pluginManifest.version
/** ほかのサイトからの呼び出しは中継しない（false を返すと 404 になる）。中継は Origin を外すので、ここで断る */
const sameSiteOnly = (req: { headers: Record<string, string | string[] | undefined> }) => (isCrossSite(req.headers, DEV_PORT) ? false : undefined)

export default defineConfig({
  plugins: [vue(), aicarnationDevBridge(), thirdPartyNotices()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION),
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      // 中継API（wrangler dev）へ流す。ブラウザから見ると同一オリジンなので、Origin ヘッダーは外して中継する
      '/api': {
        target: 'http://localhost:8787',
        bypass: sameSiteOnly,
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.removeHeader('origin'))
        },
      },
      // ローカル音声エンジン。エンジン側の CORS 設定に左右されないよう、同一オリジンで中継する
      '/tts/aivis': {
        target: 'http://127.0.0.1:10101',
        bypass: sameSiteOnly,
        rewrite: (path) => path.replace(/^\/tts\/aivis/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.removeHeader('origin'))
        },
      },
    },
  },
  build: {
    // three.js と VRM の部品はまとめて1つ（約 700 kB）。分けられない大きさなので、警告の目安をそれに合わせる
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // 3D の部品は更新が少ないので、アプリのコードと分けておく（アプリを直してもブラウザのキャッシュが効く）。
            // FBX の読み込み部品（とそれだけが使う部品）は、FBX を読むときだけ取り込むので入れない
            { name: 'three', test: /node_modules[\\/](\.pnpm[\\/])?(three|@pixiv)(?!.*(FBXLoader|NURBS|fflate))/ },
          ],
        },
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})

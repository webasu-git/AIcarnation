/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { aicarnationDevBridge } from './bridge/vitePlugin'
import { thirdPartyNotices } from './bridge/thirdPartyNotices'

export default defineConfig({
  plugins: [vue(), aicarnationDevBridge(), thirdPartyNotices()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // 中継API（wrangler dev）へ流す。ブラウザから見ると同一オリジンなので、Origin ヘッダーは外して中継する
      '/api': {
        target: 'http://localhost:8787',
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.removeHeader('origin'))
        },
      },
      // ローカル音声エンジン。エンジン側の CORS 設定に左右されないよう、同一オリジンで中継する
      '/tts/aivis': {
        target: 'http://127.0.0.1:10101',
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

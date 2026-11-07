import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
// 設定ファイルは Vite がまとめて読むため、ワークスペースのパッケージ名ではなく相対パスで読む
import {
  BRIDGE_HEADER,
  parseBridgeEvent,
  parseBridgePersona,
  type BridgeEvent,
  type BridgePersona,
} from '../../../packages/shared/src/bridge'

const MAX_BODY_BYTES = 64 * 1024
const KEEP_ALIVE_MS = 20_000

/** 自分の PC からの接続だけを受け付ける */
function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.statusCode = status
  if (body === undefined) {
    res.end()
    return
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * Claude 連携（開発版は Claude Code だけ）の受け口。開発サーバー（pnpm dev）の中で動く。
 *
 * - POST /bridge/event   … mod からの合図。`x-aicarnation-bridge: 1` ヘッダーが必須
 *                          （ブラウザが別のオリジンから送ろうとすると事前確認で止まる）
 * - GET  /bridge/stream  … 画面が購読する SSE
 * - GET/POST /bridge/persona … 選択中のエージェントの人柄（画面が POST、mod が GET）
 * - GET  /bridge/status  … 画面の接続数
 */
export function aicarnationDevBridge(): Plugin {
  const clients = new Set<ServerResponse>()
  let persona: BridgePersona | null = null

  function broadcast(event: BridgeEvent) {
    const data = `event: bridge\ndata: ${JSON.stringify(event)}\n\n`
    for (const res of clients) res.write(data)
  }

  /** 声を出すのは最後に開いた画面だけにする（複数の画面で同じ返事を二重に読み上げない） */
  function announceSpeaker() {
    const list = [...clients]
    list.forEach((res, i) => res.write(`event: role\ndata: ${JSON.stringify({ speaker: i === list.length - 1 })}\n\n`))
  }

  return {
    name: 'aicarnation-dev-bridge',
    configureServer(server) {
      server.middlewares.use('/bridge', (req, res, next) => {
        if (!isLoopback(req)) return send(res, 403, { message: 'このPCからだけ使えます' })
        // ほかのページ（同じ PC の別の開発サーバーなど）からは使わせない。画面そのもの（同じオリジン）と、
        // Origin を付けない mod（Claude Code）からだけ受け付ける
        const origin = req.headers.origin
        const port = server.config.server.port ?? 5173
        if (origin && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`) {
          return send(res, 403, { message: 'このページからは使えません' })
        }
        const path = (req.url ?? '/').split('?')[0]

        if (path === '/stream' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          res.write(': connected\n\n')
          clients.add(res)
          announceSpeaker()
          const timer = setInterval(() => res.write(': keep-alive\n\n'), KEEP_ALIVE_MS)
          req.on('close', () => {
            clearInterval(timer)
            clients.delete(res)
            announceSpeaker()
          })
          return
        }

        if (path === '/event' && req.method === 'POST') {
          if (req.headers[BRIDGE_HEADER] !== '1') return send(res, 403, { message: `${BRIDGE_HEADER} ヘッダーが必要です` })
          readJson(req)
            .then((body) => {
              const event = parseBridgeEvent(body)
              if (!event) return send(res, 400, { message: '合図の形が不正です' })
              broadcast(event)
              send(res, 200, { delivered: clients.size })
            })
            .catch(() => send(res, 400, { message: 'JSON として読めませんでした' }))
          return
        }

        if (path === '/persona' && req.method === 'GET') return send(res, 200, persona)
        if (path === '/persona' && req.method === 'POST') {
          // 合図と同じく専用のヘッダーと JSON を求める（ほかのサイトからの単純な POST で人柄を書き換えさせない）
          if (req.headers[BRIDGE_HEADER] !== '1' || !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
            return send(res, 403, { message: `${BRIDGE_HEADER} ヘッダーが必要です` })
          }
          readJson(req)
            .then((body) => {
              const parsed = parseBridgePersona(body)
              if (!parsed) return send(res, 400, { message: '人柄の形が不正です' })
              persona = parsed
              send(res, 204)
            })
            .catch(() => send(res, 400, { message: 'JSON として読めませんでした' }))
          return
        }

        if (path === '/status' && req.method === 'GET') return send(res, 200, { clients: clients.size })
        next()
      })
    },
  }
}

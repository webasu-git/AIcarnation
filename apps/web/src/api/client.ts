import type { ChatErrorCode } from '@aicarnation/shared'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'
const ANON_ID_KEY = 'aicarnation.anonId'

export type ApiErrorCode = ChatErrorCode | 'network' | 'invalid_output' | 'not_found'

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message)
  }
}

let memoryAnonId: string | null = null

/** 匿名IDは初回起動時に作って localStorage に置く。使えない環境ではそのタブの間だけ保持する */
export function getAnonId(): string {
  try {
    let id = localStorage.getItem(ANON_ID_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(ANON_ID_KEY, id)
    }
    return id
  } catch {
    memoryAnonId ??= crypto.randomUUID()
    return memoryAnonId
  }
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getAnonId()}` }
}

let registered: Promise<void> | null = null

/** /auth/anon への登録。何度呼んでも1回だけ送る（サーバー側も冪等） */
function ensureRegistered(): Promise<void> {
  registered ??= fetch(`${API_BASE}/auth/anon`, { method: 'POST', headers: authHeaders() }).then((res) => {
    if (!res.ok) throw new ApiError('unauthorized', '利用者の登録に失敗しました')
  })
  registered.catch(() => {
    registered = null
  })
  return registered
}

async function send(path: string, init: RequestInit): Promise<Response> {
  await ensureRegistered()
  return fetch(`${API_BASE}${path}`, { ...init, headers: { ...authHeaders(), ...init.headers } })
}

/**
 * 中継APIを呼ぶ。匿名IDの登録を済ませてから送り、サーバー側の登録が消えていたら登録し直して1回だけやり直す。
 * 通信自体の失敗は ApiError('network') にする。HTTP エラーの判定は呼び出し側で行う
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    let res = await send(path, init)
    if (res.status === 401) {
      registered = null
      res = await send(path, init)
    }
    return res
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('network', '通信できませんでした')
  }
}

export async function errorFromResponse(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { code?: ApiErrorCode; message?: string } | null
  return new ApiError(body?.code ?? 'upstream_error', body?.message ?? `通信エラー（${res.status}）`)
}

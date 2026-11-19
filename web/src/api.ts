export type Mode = 'update' | 'understand'

export type Evidence = {
  kind: 'source' | 'interview'
  snapshotId?: string
  path?: string
  start?: number
  end?: number
  speaker?: string
  text?: string
}

export type Topic = {
  id: string
  origin: string
  title: string
  question: string
  statement: string
  targetId: string | null
  scope: string
  evidence: Evidence[]
}

export type Claim = {
  claimId: string
  title: string
  statement: string
  origin: string
  speaker: string
  snapshotId: string
  targetId: string | null
  relatedId: string | null
  operation: string
  revision: number
  scopes: string[]
  evidence: Evidence[]
}

export type Proposal = {
  id: string
  summary: string
  readbackTurnId: string | null
}

export type Session = {
  id: string
  mode: Mode
  repo: string
  snapshotId: string
  speaker: string
  topics: Topic[]
  index: number
  seq: number
  revision: number
  pending: Proposal | null
  finished: boolean
  token: string
}

export type Node = {
  id: string
  path?: string
  start?: number
  end?: number
  origin: string
  label: string
}

export type Edge = {
  relation: string
  source: string
  target: string
  origin: string
}

export type Graph = { nodes: Node[]; edges: Edge[]; claims: Claim[]; revision: number; snapshotId: string }
export type Manifest = {
  commit: string
  files: Record<string, { text: boolean; structure: string }>
  coverage: Record<string, number>
}
export type Excerpt = { url: string; commit: string; path: string; lines: { number: number; text: string }[] }
export type Scan = {
  id: string
  status: 'queued' | 'scanning' | 'analyzing' | 'ready' | 'partial' | 'failed'
  error?: string
  snapshotId?: string
  reused?: boolean
}
export type Context = {
  focus: Node | null
  claims: Claim[]
  findings: Topic[]
  hops: (Edge & { fromLabel: string; toLabel: string })[]
  evidence: Evidence[]
  documents: { path: string; url: string }[]
  unknown: boolean
}
export type Revision = { revision: number; claim: Claim }
export type SessionEvent = { seq: number; revision: number; type: string; receipt?: Revision; evidence?: Evidence }

export const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms))

export async function request<T>(path: string, payload?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = {}
  if (payload !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = 'Bearer ' + token
  const response = await fetch(path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  if (!response.ok) {
    const problem = await response.json().catch(() => null)
    throw new Error(typeof problem?.detail === 'string' ? problem.detail : 'The request failed. Try again.')
  }
  return await response.json() as T
}

export function query(path: string, values: Record<string, string | number | boolean>) {
  return path + '?' + new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)]))
}

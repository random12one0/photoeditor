/**
 * Thin client for the local FastAPI backend. Every match/pair/burst decision
 * now happens server-side (backend/app/pipeline) -- this module is just
 * fetch calls and the wire types they return, mirroring backend/app/models.py
 * field-for-field.
 */

const BASE = '/api'

export interface ApiPhoto {
  id: string
  name: string
  path: string
  width: number
  height: number
  taken_at: number
  time_is_approximate: boolean
  thumb_ready: boolean
}

export type Side = 'before' | 'after' | 'unknown'
export type Tier = 'confirmed' | 'high' | 'uncertain'
export type ConstraintType =
  | 'pin'
  | 'unpin'
  | 'forbid'
  | 'side'
  | 'exclude'
  | 'include'
  | 'burstSplit'
  | 'burstMerge'
  | 'represent'

export interface ApiBurst {
  id: string
  photo_ids: string[]
  representative_id: string
  side: Side
}

export interface ApiSolvedPair {
  id: string
  before_id: string
  after_id: string
  score: number
  tier: Tier
  car_id: string
  inliers: number
}

export interface ApiCarSolution {
  id: string
  name: string
  bursts: ApiBurst[]
  pairs: ApiSolvedPair[]
  orphan_afters: string[]
  orphan_befores: string[]
  unknown_side: string[]
}

export interface JobSummary {
  id: string
  folder: string
  photo_count: number
  status: 'scanning' | 'embedding' | 'verifying' | 'ready' | 'error'
  progress: number
  message: string
}

export interface ConstraintIn {
  type: ConstraintType
  before?: string
  after?: string
  photo_id?: string
  side?: Side
  a?: string
  b?: string
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

export function browseFolder(): Promise<{ path?: string; cancelled: boolean }> {
  return jsonFetch('/browse', { method: 'POST' })
}

export function createJob(folder: string): Promise<JobSummary> {
  return jsonFetch('/jobs', { method: 'POST', body: JSON.stringify({ folder }) })
}

export function getJob(jobId: string): Promise<JobSummary> {
  return jsonFetch(`/jobs/${jobId}`)
}

/** Server-sent-events URL for job status -- the server pushes a message on
 * every change instead of the client having to keep asking. */
export function jobEventsUrl(jobId: string): string {
  return `${BASE}/jobs/${jobId}/events`
}

export function getPhotos(jobId: string): Promise<ApiPhoto[]> {
  return jsonFetch(`/jobs/${jobId}/photos`)
}

export function solveJob(jobId: string): Promise<ApiCarSolution[]> {
  return jsonFetch(`/jobs/${jobId}/solve`)
}

export function addConstraint(jobId: string, constraint: ConstraintIn): Promise<ApiCarSolution[]> {
  return jsonFetch(`/jobs/${jobId}/constraints`, { method: 'POST', body: JSON.stringify(constraint) })
}

export function undoLastConstraint(jobId: string): Promise<ApiCarSolution[]> {
  return jsonFetch(`/jobs/${jobId}/constraints/last`, { method: 'DELETE' })
}

export function imageUrl(jobId: string, photoId: string, full = false): string {
  return `${BASE}/jobs/${jobId}/images/${photoId}${full ? '?full=true' : ''}`
}

/** Fetch a photo's full-resolution bytes as a File -- the one place the
 * export path needs actual pixel data rather than a URL a browser can just
 * point an <img>/<canvas> at. */
export async function fetchFullFile(jobId: string, photo: ApiPhoto): Promise<File> {
  const res = await fetch(imageUrl(jobId, photo.id, true))
  if (!res.ok) throw new Error(`Failed to fetch full image for ${photo.name}`)
  const blob = await res.blob()
  return new File([blob], photo.name, { type: blob.type || 'image/jpeg', lastModified: photo.taken_at })
}

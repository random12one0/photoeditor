/** A single imported photo, plus everything we derive from it. */
export interface Photo {
  id: string
  file: File
  name: string
  /** Object URL for the downscaled proxy used everywhere in the UI. */
  proxyUrl: string
  width: number
  height: number
  /** EXIF DateTimeOriginal in ms, falling back to file.lastModified. */
  takenAt: number
  /** True when takenAt came from the filesystem rather than EXIF. */
  timeIsApproximate: boolean
  /** 64-bit difference hash, as a 16-char hex string. */
  dhash: string
  /** Coarse 4x4 RGB signature for a second similarity opinion. */
  colorSig: number[]
  /** Exposure-invariant 4x4 chromaticity signature. Separates car from car. */
  chromaSig: number[]
  /** Contrast-normalised 16x16 luma grid. The main same-shot signal. */
  lumaGrid: number[]
  /** Mean luminance 0-255. A clean car is usually brighter than a dirty one. */
  luma: number
}

/** A cluster of photos believed to be the same car / same session. */
export interface Group {
  id: string
  /** User-facing name. Defaults to a timestamp label, editable. */
  name: string
  photoIds: string[]
  pairs: Pair[]
}

export interface Pair {
  id: string
  beforeId: string
  afterId: string
  /** 0-1. How confident the auto-matcher was. 1 for hand-made pairs. */
  confidence: number
  /** Auto-suggested pairs start unconfirmed; the review screen confirms them. */
  confirmed: boolean
}

export type OutputRatio = '4:5' | '1:1' | '9:16' | '3:4'
export type FitMode = 'cover' | 'contain'
export type BackgroundSource = 'after' | 'before' | 'blend'

/** Every knob the renderer exposes. Persisted between sessions. */
export interface StylePreset {
  ratio: OutputRatio
  /** Long edge of the exported JPEG, in px. */
  exportSize: number
  jpegQuality: number

  // Background
  bgSource: BackgroundSource
  bgBlur: number
  bgDarken: number
  bgZoom: number
  bgSaturation: number

  // Layout
  padding: number
  gap: number
  fitMode: FitMode

  // Photo treatment
  cornerRadius: number
  shadowBlur: number
  shadowOpacity: number
  shadowOffsetY: number
  borderWidth: number
  borderOpacity: number

  // Labels
  showLabels: boolean
  beforeLabel: string
  afterLabel: string
  labelSize: number
  labelOpacity: number

  // Watermark
  watermarkText: string
  watermarkSize: number
  watermarkOpacity: number
}

export interface ClusterSettings {
  /** Photos within this many minutes of each other lean toward the same car. */
  timeGapMinutes: number
  /** Min cross-correlation (-1..1) for two shots to count as the same framing. */
  nccThreshold: number
  /** Min cross-correlation for the tighter before/after pairing pass. */
  pairNccThreshold: number
  /** Max chroma distance (0-1) before two shots are ruled different cars. */
  chromaThreshold: number
}

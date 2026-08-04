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
  /** Contrast-normalised 16x16 luma grid. */
  lumaGrid: number[]
  /** Contrast-normalised 8x8 grid — coarse enough to survive framing drift. */
  lumaGridCoarse: number[]
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
export type BackgroundSource = 'after' | 'before' | 'blend'
/** Which photo sits on top of the stack. */
export type StackOrder = 'after-first' | 'before-first'
/** 'each' keeps both photos' own shapes; 'match' crops them to one frame. */
export type FrameFit = 'each' | 'match'
/** Stacked reads better in a feed; side-by-side suits wide crops. */
export type Layout = 'stacked' | 'side-by-side'

/** Every knob the renderer exposes. Persisted between sessions. */
export interface StylePreset {
  ratio: OutputRatio
  /** Long edge of the exported JPEG, in px. */
  exportSize: number
  jpegQuality: number
  order: StackOrder
  layout: Layout

  // Background
  bgSource: BackgroundSource
  bgBlur: number
  bgDarken: number
  bgZoom: number
  bgSaturation: number

  // Layout
  padding: number
  paddingY: number
  gap: number
  frameFit: FrameFit

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
  /** Optional logo, stored as a data URL so it survives a reload. */
  watermarkLogo: string | null
  watermarkLogoScale: number
}

/** A named style the user can switch between (feed look vs story look). */
export interface SavedPreset {
  id: string
  name: string
  preset: StylePreset
}

export interface ClusterSettings {
  /** A break this long means the next photo belongs to a different car. */
  newCarGapMinutes: number
  /** No car spans longer than this, end to end. */
  maxCarSpanHours: number
  /** 0 trusts only how photos look; 1 trusts only walk-around order. */
  orderWeight: number
  /** Below this match, no pair is suggested at all. */
  minPairScore: number
}

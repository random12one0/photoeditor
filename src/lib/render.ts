import { scratch } from './canvasPool'
import type { OutputRatio, StylePreset } from '../types'

export const RATIOS: Record<OutputRatio, number> = {
  '4:5': 4 / 5,
  '1:1': 1,
  '9:16': 9 / 16,
  '3:4': 3 / 4,
}

/**
 * Defaults measured from the user's own exports (see test/measure.mjs), which
 * were remarkably consistent across five collages:
 *
 *   side margin    8.71% of canvas width
 *   top / bottom   4.73% / 4.68%
 *   gap            1.56%       ← opened up here, by request
 *   corner radius  0.47%
 *   backdrop       heavy blur, mid-grey, only lightly darkened
 *
 * Two structural details from the same measurements, both of which the first
 * version of this renderer got wrong: the finished car sits on TOP in all five,
 * and the two photos keep their own aspect ratios rather than being cropped to
 * a shared frame.
 */
export const DEFAULT_PRESET: StylePreset = {
  ratio: '4:5',
  exportSize: 2000,
  jpegQuality: 0.92,

  order: 'after-first',
  layout: 'stacked',

  bgSource: 'after',
  bgBlur: 8,
  bgDarken: 0.28,
  bgZoom: 1.18,
  bgSaturation: 1.05,

  padding: 8.7,
  paddingY: 4.7,
  gap: 2.6,
  frameFit: 'each',

  cornerRadius: 4.7,
  shadowBlur: 9,
  shadowOpacity: 0.42,
  shadowOffsetY: 2.4,
  borderWidth: 0.18,
  borderOpacity: 0,

  showLabels: false,
  beforeLabel: 'BEFORE',
  afterLabel: 'AFTER',
  labelSize: 2.6,
  labelOpacity: 0.9,

  watermarkText: '',
  watermarkSize: 1.9,
  watermarkOpacity: 0.55,
  watermarkLogo: null,
  watermarkLogoScale: 12,
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

export interface RenderInput {
  before: ImageBitmap
  after: ImageBitmap
  /** Decoded logo, when the preset carries one. */
  logo?: ImageBitmap | null
}

/** Canvas dimensions for a ratio at a given long-edge size. */
export function canvasSize(ratio: OutputRatio, longEdge: number) {
  const r = RATIOS[ratio]
  return r <= 1
    ? { width: Math.round(longEdge * r), height: longEdge }
    : { width: longEdge, height: Math.round(longEdge / r) }
}

function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  if (typeof (ctx as CanvasRenderingContext2D).roundRect === 'function') {
    ;(ctx as CanvasRenderingContext2D).roundRect(x, y, w, h, radius)
    return
  }
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/** Draw a bitmap to fill a box, cropping the overflow. */
function drawCover(
  ctx: Ctx2D,
  img: ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom = 1,
) {
  const scale = Math.max(w / img.width, h / img.height) * zoom
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

/**
 * Blurred, darkened backdrop.
 *
 * The blur runs on a small proxy and is then scaled up: a large ctx.filter blur
 * across a 2000px canvas takes seconds on a phone, while this is instant and,
 * once the blur is this heavy, visually identical.
 */
function drawBackdrop(
  ctx: Ctx2D,
  img: ImageBitmap,
  W: number,
  H: number,
  preset: StylePreset,
) {
  const SMALL_EDGE = 320
  const f = SMALL_EDGE / Math.max(W, H)
  const sw = Math.max(2, Math.round(W * f))
  const sh = Math.max(2, Math.round(H * f))

  const small = scratch('backdrop-small', sw, sh)
  const sctx = small.getContext('2d') as Ctx2D
  sctx.clearRect(0, 0, sw, sh)
  drawCover(sctx, img, 0, 0, sw, sh, preset.bgZoom)

  const blurred = scratch('backdrop-blur', sw, sh)
  const bctx = blurred.getContext('2d') as Ctx2D
  bctx.clearRect(0, 0, sw, sh)
  const smallBlur = Math.max(0, (preset.bgBlur / 100) * W * f)
  const filters: string[] = []
  if (smallBlur > 0.2) filters.push(`blur(${smallBlur.toFixed(2)}px)`)
  if (preset.bgSaturation !== 1) filters.push(`saturate(${preset.bgSaturation})`)
  if (filters.length && 'filter' in bctx) bctx.filter = filters.join(' ')
  bctx.drawImage(small as CanvasImageSource, 0, 0)
  if ('filter' in bctx) bctx.filter = 'none'

  ctx.save()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  // Overdraw slightly so the blur's soft edges never show as a seam.
  const bleed = Math.max(W, H) * 0.02
  ctx.drawImage(
    blurred as CanvasImageSource,
    -bleed,
    -bleed,
    W + bleed * 2,
    H + bleed * 2,
  )
  ctx.restore()

  if (preset.bgDarken > 0) {
    ctx.fillStyle = `rgba(0,0,0,${preset.bgDarken})`
    ctx.fillRect(0, 0, W, H)
  }
}

function drawFramedPhoto(
  ctx: Ctx2D,
  img: ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
  preset: StylePreset,
  unit: number,
) {
  const radius = (preset.cornerRadius / 100) * unit * 10
  const shadowBlur = (preset.shadowBlur / 100) * unit * 10
  const shadowOffset = (preset.shadowOffsetY / 100) * unit * 10

  // Shadow, cast by an opaque rounded rect so it isn't tinted by the photo.
  if (preset.shadowOpacity > 0 && shadowBlur > 0) {
    ctx.save()
    ctx.shadowColor = `rgba(0,0,0,${preset.shadowOpacity})`
    ctx.shadowBlur = shadowBlur
    ctx.shadowOffsetY = shadowOffset
    ctx.fillStyle = '#000'
    roundRectPath(ctx, x, y, w, h, radius)
    ctx.fill()
    ctx.restore()
  }

  ctx.save()
  roundRectPath(ctx, x, y, w, h, radius)
  ctx.clip()
  drawCover(ctx, img, x, y, w, h)
  ctx.restore()

  const borderW = (preset.borderWidth / 100) * unit * 10
  if (preset.borderOpacity > 0 && borderW > 0) {
    ctx.save()
    ctx.strokeStyle = `rgba(255,255,255,${preset.borderOpacity})`
    ctx.lineWidth = borderW
    roundRectPath(ctx, x + borderW / 2, y + borderW / 2, w - borderW, h - borderW, radius)
    ctx.stroke()
    ctx.restore()
  }
}

function drawLabel(
  ctx: Ctx2D,
  text: string,
  x: number,
  y: number,
  preset: StylePreset,
  unit: number,
) {
  if (!text) return
  const size = (preset.labelSize / 100) * unit * 10
  const inset = size * 0.7

  ctx.save()
  ctx.font = `700 ${size}px ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif`
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${size * 0.08}px`
  ctx.shadowColor = 'rgba(0,0,0,0.65)'
  ctx.shadowBlur = size * 0.5
  ctx.shadowOffsetY = size * 0.06
  ctx.fillStyle = `rgba(255,255,255,${preset.labelOpacity})`
  ctx.fillText(text, x + inset, y + inset)
  ctx.restore()
}

/**
 * Compose one before/after image.
 *
 * Every spatial value in the preset is a percentage of canvas width, so a
 * preview rendered at 320px and an export rendered at 2000px are proportionally
 * identical — what the editor shows is what lands in the export.
 */
export function renderComposite(
  canvas: AnyCanvas,
  input: RenderInput,
  preset: StylePreset,
): void {
  const W = canvas.width
  const H = canvas.height
  const unit = W / 100
  const ctx = canvas.getContext('2d') as Ctx2D

  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = '#0b0d11'
  ctx.fillRect(0, 0, W, H)

  const bgImg = preset.bgSource === 'before' ? input.before : input.after
  drawBackdrop(ctx, bgImg, W, H, preset)
  if (preset.bgSource === 'blend') {
    ctx.save()
    ctx.globalAlpha = 0.5
    drawBackdrop(ctx, input.before, W, H, preset)
    ctx.restore()
  }

  // The finished car goes on top by default — that's how the reference edits
  // are laid out, and it's what reads as the payoff shot.
  const [top, bottom] =
    preset.order === 'after-first'
      ? [input.after, input.before]
      : [input.before, input.after]

  const padX = (preset.padding / 100) * W
  const padY = (preset.paddingY / 100) * W
  const gap = (preset.gap / 100) * W
  const availW = W - padX * 2
  const availH = H - padY * 2

  const aspectA = top.width / top.height
  const aspectB = bottom.width / bottom.height

  /* Side-by-side is the same problem rotated, so solve it in the long axis of
     whichever arrangement is in play rather than duplicating the maths. */
  const sideBySide = preset.layout === 'side-by-side'
  const spanAvail = sideBySide ? availW : availH
  const crossAvail = sideBySide ? availH : availW

  let cross: number
  let spanA: number
  let spanB: number

  if (preset.frameFit === 'match') {
    // One shared frame, both photos cropped into it. Reads as a matched set, at
    // the cost of trimming whichever shot is the odd shape.
    const aspect = (aspectA + aspectB) / 2
    cross = crossAvail
    let span = sideBySide ? cross * aspect : cross / aspect
    if (span * 2 + gap > spanAvail) {
      span = (spanAvail - gap) / 2
      cross = Math.min(crossAvail, sideBySide ? span / aspect : span * aspect)
    }
    spanA = span
    spanB = span
  } else {
    // Each photo keeps its own shape at a shared cross-axis size — no cropping.
    cross = crossAvail
    spanA = sideBySide ? cross * aspectA : cross / aspectA
    spanB = sideBySide ? cross * aspectB : cross / aspectB
    const total = spanA + spanB + gap
    if (total > spanAvail) {
      const k = (spanAvail - gap) / (spanA + spanB)
      cross *= k
      spanA *= k
      spanB *= k
    }
  }

  const stack = spanA + spanB + gap
  let boxA: [number, number, number, number]
  let boxB: [number, number, number, number]

  if (sideBySide) {
    const y = (H - cross) / 2
    const xA = (W - stack) / 2
    boxA = [xA, y, spanA, cross]
    boxB = [xA + spanA + gap, y, spanB, cross]
  } else {
    const x = (W - cross) / 2
    const yA = (H - stack) / 2
    boxA = [x, yA, cross, spanA]
    boxB = [x, yA + spanA + gap, cross, spanB]
  }

  drawFramedPhoto(ctx, top, ...boxA, preset, unit)
  drawFramedPhoto(ctx, bottom, ...boxB, preset, unit)

  if (preset.showLabels) {
    const labelA = preset.order === 'after-first' ? preset.afterLabel : preset.beforeLabel
    const labelB = preset.order === 'after-first' ? preset.beforeLabel : preset.afterLabel
    drawLabel(ctx, labelA, boxA[0], boxA[1], preset, unit)
    drawLabel(ctx, labelB, boxB[0], boxB[1], preset, unit)
  }

  if (input.logo) {
    const logoW = (preset.watermarkLogoScale / 100) * W
    const logoH = (logoW / input.logo.width) * input.logo.height
    ctx.save()
    ctx.globalAlpha = preset.watermarkOpacity
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = logoW * 0.08
    ctx.drawImage(input.logo, (W - logoW) / 2, H - padY - logoH, logoW, logoH)
    ctx.restore()
  } else if (preset.watermarkText) {
    const size = (preset.watermarkSize / 100) * unit * 10
    ctx.save()
    ctx.font = `600 ${size}px ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${size * 0.12}px`
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = size * 0.6
    ctx.fillStyle = `rgba(255,255,255,${preset.watermarkOpacity})`
    ctx.fillText(preset.watermarkText, W / 2, H - Math.max(padY, size) * 0.9)
    ctx.restore()
  }
}

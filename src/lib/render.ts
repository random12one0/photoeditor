import type { OutputRatio, StylePreset } from '../types'

export const RATIOS: Record<OutputRatio, number> = {
  '4:5': 4 / 5,
  '1:1': 1,
  '9:16': 9 / 16,
  '3:4': 3 / 4,
}

export const DEFAULT_PRESET: StylePreset = {
  ratio: '4:5',
  exportSize: 2000,
  jpegQuality: 0.92,

  bgSource: 'after',
  bgBlur: 6,
  bgDarken: 0.45,
  bgZoom: 1.15,
  bgSaturation: 1.1,

  padding: 6,
  gap: 3.2,
  fitMode: 'cover',

  cornerRadius: 2.4,
  shadowBlur: 4.5,
  shadowOpacity: 0.55,
  shadowOffsetY: 1.2,
  borderWidth: 0.18,
  borderOpacity: 0.16,

  showLabels: false,
  beforeLabel: 'BEFORE',
  afterLabel: 'AFTER',
  labelSize: 2.6,
  labelOpacity: 0.9,

  watermarkText: '',
  watermarkSize: 1.9,
  watermarkOpacity: 0.55,
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

export interface RenderInput {
  before: ImageBitmap
  after: ImageBitmap
}

/** Canvas dimensions for a ratio at a given long-edge size. */
export function canvasSize(ratio: OutputRatio, longEdge: number) {
  const r = RATIOS[ratio]
  return r <= 1
    ? { width: Math.round(longEdge * r), height: longEdge }
    : { width: longEdge, height: Math.round(longEdge / r) }
}

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
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

/** Draw a bitmap inside a box without cropping, letterboxing the remainder. */
function drawContain(
  ctx: Ctx2D,
  img: ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const scale = Math.min(w / img.width, h / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

/**
 * Blurred, darkened backdrop. The blur is done on a small proxy and then scaled
 * up — a large ctx.filter blur on a 2000px canvas takes seconds on a phone,
 * whereas this is instant and visually identical once it's this soft.
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

  const small = makeCanvas(sw, sh)
  const sctx = small.getContext('2d') as Ctx2D
  drawCover(sctx, img, 0, 0, sw, sh, preset.bgZoom)

  const blurred = makeCanvas(sw, sh)
  const bctx = blurred.getContext('2d') as Ctx2D
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

  // Photo, clipped to the rounded frame.
  ctx.save()
  roundRectPath(ctx, x, y, w, h, radius)
  ctx.clip()
  if (preset.fitMode === 'cover') {
    drawCover(ctx, img, x, y, w, h)
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillRect(x, y, w, h)
    drawContain(ctx, img, x, y, w, h)
  }
  ctx.restore()

  // Hairline border to lift the photo off the backdrop.
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
  ctx.letterSpacing = `${size * 0.08}px`
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
 * Every spatial value in the preset is a percentage of the canvas width, so a
 * preview rendered at 600px and an export rendered at 2000px are pixel-for-pixel
 * proportional — what you see in the editor is what lands in the ZIP.
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

  const padX = (preset.padding / 100) * W
  const gap = (preset.gap / 100) * W
  const availW = W - padX * 2
  const availH = H - padX * 2

  // Both frames share one aspect so the pair reads as a matched set. Averaging
  // the two sources keeps the crop honest when the shots differ slightly.
  const aspect =
    (input.before.width / input.before.height + input.after.width / input.after.height) / 2

  let frameW = availW
  let frameH = frameW / aspect
  if (frameH * 2 + gap > availH) {
    frameH = (availH - gap) / 2
    frameW = Math.min(availW, frameH * aspect)
  }

  const stackH = frameH * 2 + gap
  const x = (W - frameW) / 2
  const yTop = (H - stackH) / 2
  const yBottom = yTop + frameH + gap

  drawFramedPhoto(ctx, input.before, x, yTop, frameW, frameH, preset, unit)
  drawFramedPhoto(ctx, input.after, x, yBottom, frameW, frameH, preset, unit)

  if (preset.showLabels) {
    drawLabel(ctx, preset.beforeLabel, x, yTop, preset, unit)
    drawLabel(ctx, preset.afterLabel, x, yBottom, preset, unit)
  }

  if (preset.watermarkText) {
    const size = (preset.watermarkSize / 100) * unit * 10
    ctx.save()
    ctx.font = `600 ${size}px ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.letterSpacing = `${size * 0.12}px`
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = size * 0.6
    ctx.fillStyle = `rgba(255,255,255,${preset.watermarkOpacity})`
    ctx.fillText(preset.watermarkText, W / 2, H - padX * 0.42)
    ctx.restore()
  }
}

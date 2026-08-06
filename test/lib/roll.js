/**
 * Synthetic camera-roll generator, shared by the test harnesses.
 *
 * Served to the browser by the Vite dev server so it can use canvas, and so it
 * can call the app's own hashing code rather than a reimplementation of it.
 */

import {
  COARSE_GRID,
  LUMA_GRID,
  QUALITY_GRID,
  chromaSignature,
  colorHistogram,
  colorSignature,
  dhashFromImageData,
  edgeHistogram,
  lumaGridFromImageData,
  meanLuma,
} from '/src/lib/hash.ts'
import { FEATURE_EDGE, detectAndDescribe } from '/src/lib/features.ts'

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * Draw one shot of one car.
 *
 * A "before" is dimmer and covered in dirt; an "after" is bright and has a
 * specular highlight. Same car + same angle must stay recognisable across that
 * change, while different angles and different cars must not.
 */
export function drawScene(spec, cfg = {}) {
  const portrait = cfg.mixedOrientation && spec.angle % 2 === 1
  const W = portrait ? 600 : 800
  const H = portrait ? 800 : 600

  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const rand = rng(spec.car * 7919 + spec.angle * 104729 + (spec.dirty ? 1 : 2))

  const hue = (spec.car * (cfg.hueStep ?? 45)) % 360
  const sat = cfg.saturation ?? 60

  // Dirt darkens the car, not the whole world. The shop lighting is the same
  // before and after; only the ambient drifts a little with the time of day.
  const ambient = 1 + ((spec.car % 3) - 1) * 0.05
  const bright = spec.dirty ? 0.82 : 1

  // Handheld drift: the after shot is framed slightly differently.
  const drift = cfg.drift && !spec.dirty ? 26 : 0
  const dx = drift ? (rand() - 0.5) * drift : 0
  const dy = drift ? (rand() - 0.5) * drift : 0

  // The bay: identical for every car, which is exactly what makes this hard.
  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, `hsl(205 12% ${34 * ambient}%)`)
  grad.addColorStop(1, `hsl(205 8% ${16 * ambient}%)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)

  // Fixed shop fittings — roller door, wall seam, drain — give every photo in
  // the bay a shared structural backdrop.
  ctx.fillStyle = `hsl(205 6% ${24 * ambient}%)`
  ctx.fillRect(0, 0, W, H * 0.14)
  ctx.fillStyle = `hsl(205 5% ${28 * ambient}%)`
  for (let i = 0; i < 8; i++) ctx.fillRect(0, H * 0.015 * i * 1.1, W, H * 0.006)

  if (spec.closeup) {
    ctx.fillStyle = `hsl(0 0% ${8 * bright + 3}%)`
    ctx.beginPath()
    ctx.arc(W / 2, H / 2, Math.min(W, H) * 0.38, 0, Math.PI * 2)
    ctx.fill()
    // Spoke count and rotation vary by car — different cars, different wheels.
    const spokes = 5 + (spec.car % 4)
    ctx.fillStyle = `hsl(${hue} ${sat}% ${62 * bright + 12}%)`
    for (let i = 0; i < spokes; i++) {
      const ang = (i / spokes) * Math.PI * 2 + spec.angle + spec.car
      ctx.beginPath()
      ctx.moveTo(W / 2, H / 2)
      ctx.arc(W / 2, H / 2, Math.min(W, H) * 0.27, ang - 0.16, ang + 0.16)
      ctx.closePath()
      ctx.fill()
    }
  } else {
    const ax = 40 + ((spec.angle * 137) % 5) * (W * 0.09) + dx
    const ay = H * 0.3 + ((spec.angle * 89) % 4) * (H * 0.07) + dy
    const bodyW = W * 0.52
    const bodyH = H * 0.24

    ctx.fillStyle = `hsl(${hue} ${sat * (spec.dirty ? 0.75 : 1)}% ${(34 * bright + 8) * ambient}%)`
    ctx.beginPath()
    ctx.ellipse(
      ax + bodyW / 2,
      ay + bodyH * 0.85,
      bodyW * 0.66,
      bodyH * 0.72,
      0,
      0,
      Math.PI * 2,
    )
    ctx.fill()
    ctx.fillRect(ax, ay, bodyW, bodyH)

    ctx.fillStyle = `hsl(${hue} ${Math.max(6, sat - 30)}% ${(56 * bright + 10) * ambient}%)`
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(
        ax + bodyW * 0.06 + i * bodyW * 0.3,
        ay + bodyH * 0.12,
        bodyW * 0.22,
        bodyH * 0.4,
      )
    }
    ctx.fillStyle = `hsl(0 0% ${(9 * bright + 4) * ambient}%)`
    for (const wx of [ax + bodyW * 0.18, ax + bodyW * 0.8]) {
      ctx.beginPath()
      ctx.arc(wx, ay + bodyH * 1.1, Math.min(W, H) * 0.075, 0, Math.PI * 2)
      ctx.fill()
    }

    // Shop floor — same grey for every car.
    ctx.fillStyle = `hsl(205 4% ${21 * ambient}%)`
    ctx.fillRect(0, ay + bodyH * 1.35, W, H)

    if (spec.dirty) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(ax - bodyW * 0.12, ay - bodyH * 0.1, bodyW * 1.25, bodyH * 1.7)
      ctx.clip()
      ctx.globalAlpha = 0.3
      ctx.fillStyle = '#6b5637'
      for (let i = 0; i < 900; i++) {
        ctx.fillRect(
          ax - bodyW * 0.12 + rand() * bodyW * 1.25,
          ay - bodyH * 0.1 + rand() * bodyH * 1.7,
          1 + rand() * 4,
          1 + rand() * 4,
        )
      }
      ctx.globalAlpha = 1
      ctx.restore()
    } else {
      ctx.globalAlpha = 0.15
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.ellipse(
        ax + bodyW * 0.45,
        ay + bodyH * 0.25,
        bodyW * 0.4,
        bodyH * 0.17,
        -0.2,
        0,
        Math.PI * 2,
      )
      ctx.fill()
      ctx.globalAlpha = 1
    }
  }

  // Sensor noise, so no two shots are ever byte-identical.
  const noise = ctx.getImageData(0, 0, W, H)
  for (let i = 0; i < noise.data.length; i += 4) {
    const n = (rand() - 0.5) * 10
    noise.data[i] += n
    noise.data[i + 1] += n
    noise.data[i + 2] += n
  }
  ctx.putImageData(noise, 0, 0)

  return c
}

/** The same scene, encoded as a JPEG blob — for driving the real import path. */
export function drawToBlob(spec, cfg = {}) {
  const c = drawScene(spec, cfg)
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9))
}

/** A scene reduced to the fingerprint fields the clustering code needs. */
export function makePhoto(spec, cfg = {}) {
  const c = drawScene(spec, cfg)

  const grid = (gw, gh) => {
    const g = document.createElement('canvas')
    g.width = gw
    g.height = gh
    const gctx = g.getContext('2d', { willReadFrequently: true })
    gctx.drawImage(c, 0, 0, gw, gh)
    return gctx.getImageData(0, 0, gw, gh)
  }

  const hashGrid = grid(9, 8)
  const colorGrid = grid(32, 32)
  const structureGrid = grid(LUMA_GRID, LUMA_GRID)
  const coarseGrid = grid(COARSE_GRID, COARSE_GRID)
  const bigGrid = grid(QUALITY_GRID, QUALITY_GRID)

  return {
    id: spec.id,
    file: null,
    name: spec.name,
    proxyUrl: '',
    width: c.width,
    height: c.height,
    takenAt: spec.takenAt,
    timeIsApproximate: false,
    dhash: dhashFromImageData(hashGrid),
    colorSig: colorSignature(colorGrid),
    chromaSig: chromaSignature(colorGrid),
    lumaGrid: lumaGridFromImageData(structureGrid),
    lumaGridCoarse: lumaGridFromImageData(coarseGrid),
    colorHist: colorHistogram(bigGrid),
    edgeHist: edgeHistogram(bigGrid),
    features: detectAndDescribe(
      (() => {
        // The detector needs the scene's real shape, not a square.
        const g = document.createElement('canvas')
        const s = Math.min(1, FEATURE_EDGE / Math.max(c.width, c.height))
        g.width = Math.round(c.width * s)
        g.height = Math.round(c.height * s)
        const gctx = g.getContext('2d', { willReadFrequently: true })
        gctx.drawImage(c, 0, 0, g.width, g.height)
        return gctx.getImageData(0, 0, g.width, g.height)
      })(),
    ),
    luma: meanLuma(colorGrid),
  }
}

const MIN = 60_000

/**
 * Build a whole day's roll from a scenario config, along with the ground truth
 * needed to score the algorithm against it.
 */
export function buildRoll(cfg) {
  const photos = []
  const truthGroup = new Map()
  const truthPair = new Map()
  let t = new Date('2026-03-02T08:00:00Z').getTime()
  let idn = 0

  for (let car = 1; car <= cfg.cars; car++) {
    const beforeOnly = cfg.beforeOnlyEvery && car % cfg.beforeOnlyEvery === 0
    const carStart = t

    for (let a = 1; a <= cfg.angles; a++) {
      const id = `p${idn++}`
      photos.push(
        makePhoto(
          {
            id,
            car,
            angle: a,
            dirty: true,
            name: `car${car}_before_${a}`,
            takenAt: carStart + a * 2 * MIN + (cfg.jitterOnly ? (idn % 7) * 9000 : 0),
          },
          cfg,
        ),
      )
      truthGroup.set(id, car)
      if (!beforeOnly) truthPair.set(id, `${car}:${a}`)
    }

    if (!beforeOnly) {
      const afterStart = carStart + cfg.detailMinutes * MIN
      for (let a = 1; a <= cfg.angles; a++) {
        const id = `p${idn++}`
        photos.push(
          makePhoto(
            {
              id,
              car,
              angle: a,
              dirty: false,
              name: `car${car}_after_${a}`,
              takenAt: afterStart + a * 2 * MIN,
            },
            cfg,
          ),
        )
        truthGroup.set(id, car)
        truthPair.set(id, `${car}:${a}`)
      }
    }

    for (let e = 0; e < (cfg.extras ?? 0); e++) {
      const id = `p${idn++}`
      photos.push(
        makePhoto(
          {
            id,
            car,
            angle: 40 + e * 13,
            dirty: false,
            closeup: true,
            name: `car${car}_extra_${e}`,
            takenAt: carStart + (cfg.detailMinutes + 20 + e * 3) * MIN,
          },
          cfg,
        ),
      )
      truthGroup.set(id, car)
    }

    t = carStart + (cfg.detailMinutes + cfg.gapMinutes) * MIN
  }

  return { photos, truthGroup, truthPair }
}

import { useMemo, useRef, useState } from 'react'
import { DEFAULT_PRESET } from '../lib/render'
import type { Group, OutputRatio, Photo, SavedPreset, StylePreset } from '../types'
import Icon from './Icon'
import PairPreview from './PairPreview'

interface Props {
  groups: Group[]
  photoMap: Map<string, Photo>
  preset: StylePreset
  savedPresets: SavedPreset[]
  onChange: (p: StylePreset) => void
  onSavePreset: (name: string) => void
  onApplyPreset: (id: string) => void
  onDeletePreset: (id: string) => void
  onNext: () => void
  notify: (msg: string, undoable?: boolean) => void
}

const RATIOS: { value: OutputRatio; label: string; hint: string }[] = [
  { value: '4:5', label: '4:5', hint: 'Feed' },
  { value: '1:1', label: '1:1', hint: 'Square' },
  { value: '9:16', label: '9:16', hint: 'Story' },
  { value: '3:4', label: '3:4', hint: 'Portrait' },
]

/** Sections start closed except the two people actually touch. */
const INITIAL_OPEN = new Set(['Layout', 'Background'])

export default function StyleView({
  groups,
  photoMap,
  preset,
  savedPresets,
  onChange,
  onSavePreset,
  onApplyPreset,
  onDeletePreset,
  onNext,
  notify,
}: Props) {
  const [sampleIndex, setSampleIndex] = useState(0)
  const [open, setOpen] = useState<Set<string>>(INITIAL_OPEN)
  const logoInput = useRef<HTMLInputElement>(null)

  const samples = useMemo(() => {
    const out: { before: Photo; after: Photo; groupName: string }[] = []
    for (const g of groups) {
      for (const pair of g.pairs) {
        const before = photoMap.get(pair.beforeId)
        const after = photoMap.get(pair.afterId)
        if (before && after) out.push({ before, after, groupName: g.name })
      }
    }
    return out
  }, [groups, photoMap])

  const sample = samples[Math.min(sampleIndex, samples.length - 1)]

  const set = <K extends keyof StylePreset>(key: K, value: StylePreset[K]) =>
    onChange({ ...preset, [key]: value })

  const toggleSection = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const slider = (
    key: keyof StylePreset,
    label: string,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string = (v) => String(v),
  ) => (
    <label className="field" key={key}>
      <span className="field-label">
        {label} <b>{format(preset[key] as number)}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={preset[key] as number}
        onChange={(e) => set(key, Number(e.target.value) as StylePreset[typeof key])}
      />
    </label>
  )

  const section = (name: string, body: React.ReactNode) => {
    const isOpen = open.has(name)
    return (
      <div className="fieldset" data-open={isOpen} key={name}>
        <button
          className="fieldset-head"
          onClick={() => toggleSection(name)}
          aria-expanded={isOpen}
        >
          {name}
          <Icon name="chevronDown" size={17} className="chev" />
        </button>
        {isOpen && <div className="fieldset-body">{body}</div>}
      </div>
    )
  }

  const readLogo = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      set('watermarkLogo', typeof reader.result === 'string' ? reader.result : null)
      notify('Logo added')
    }
    reader.onerror = () => notify('Could not read that image')
    reader.readAsDataURL(file)
  }

  return (
    <>
      <main className="content has-actionbar" data-view="style">
        <div className="wrap style-layout">
          <div className="style-preview">
            {sample ? (
              <>
                <PairPreview
                  before={sample.before}
                  after={sample.after}
                  preset={preset}
                  maxWidth={300}
                />
                {samples.length > 1 && (
                  <div className="preview-nav">
                    <button
                      className="icon-btn"
                      disabled={sampleIndex === 0}
                      onClick={() => setSampleIndex((i) => Math.max(0, i - 1))}
                      aria-label="Previous sample"
                    >
                      <Icon name="chevronLeft" size={18} />
                    </button>
                    <span className="tiny dim mono">
                      {sampleIndex + 1} / {samples.length}
                    </span>
                    <button
                      className="icon-btn"
                      disabled={sampleIndex >= samples.length - 1}
                      onClick={() => setSampleIndex((i) => Math.min(samples.length - 1, i + 1))}
                      aria-label="Next sample"
                    >
                      <Icon name="chevronRight" size={18} />
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="muted tiny" style={{ padding: 24, textAlign: 'center' }}>
                Confirm some pairs first and they'll preview here.
              </p>
            )}
          </div>

          <div>
            {savedPresets.length > 0 && (
              <div className="preset-row" style={{ marginBottom: 12 }}>
                {savedPresets.map((sp) => (
                  <span key={sp.id} style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                    <button className="chip" onClick={() => onApplyPreset(sp.id)}>
                      <Icon name="sparkle" size={14} />
                      {sp.name}
                    </button>
                    <button
                      className="icon-btn"
                      style={{ width: 34, height: 38 }}
                      onClick={() => onDeletePreset(sp.id)}
                      aria-label={`Delete ${sp.name}`}
                    >
                      <Icon name="close" size={15} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {section(
              'Layout',
              <>
                <div className="grid-4">
                  {RATIOS.map((r) => (
                    <button
                      key={r.value}
                      className="ratio-btn"
                      aria-pressed={preset.ratio === r.value}
                      onClick={() => set('ratio', r.value)}
                    >
                      <b>{r.label}</b>
                      <span className="tiny dim">{r.hint}</span>
                    </button>
                  ))}
                </div>

                <div className="field">
                  <span className="field-label">Arrangement</span>
                  <div className="seg">
                    <button
                      aria-pressed={preset.layout === 'stacked'}
                      onClick={() => set('layout', 'stacked')}
                    >
                      Stacked
                    </button>
                    <button
                      aria-pressed={preset.layout === 'side-by-side'}
                      onClick={() => set('layout', 'side-by-side')}
                    >
                      Side by side
                    </button>
                  </div>
                </div>

                <div className="field">
                  <span className="field-label">Which comes first</span>
                  <div className="seg">
                    <button
                      aria-pressed={preset.order === 'after-first'}
                      onClick={() => set('order', 'after-first')}
                    >
                      After first
                    </button>
                    <button
                      aria-pressed={preset.order === 'before-first'}
                      onClick={() => set('order', 'before-first')}
                    >
                      Before first
                    </button>
                  </div>
                </div>

                <div className="field">
                  <span className="field-label">Photo shapes</span>
                  <div className="seg">
                    <button
                      aria-pressed={preset.frameFit === 'each'}
                      onClick={() => set('frameFit', 'each')}
                    >
                      Keep each
                    </button>
                    <button
                      aria-pressed={preset.frameFit === 'match'}
                      onClick={() => set('frameFit', 'match')}
                    >
                      Crop to match
                    </button>
                  </div>
                </div>

                {slider('padding', 'Side margin', 0, 18, 0.1, (v) => `${v.toFixed(1)}%`)}
                {slider('paddingY', 'Top & bottom margin', 0, 18, 0.1, (v) => `${v.toFixed(1)}%`)}
                {slider('gap', 'Gap between photos', 0, 15, 0.1, (v) => `${v.toFixed(1)}%`)}
              </>,
            )}

            {section(
              'Background',
              <>
                <div className="field">
                  <span className="field-label">Taken from</span>
                  <div className="seg">
                    {(['after', 'before', 'blend'] as const).map((s) => (
                      <button
                        key={s}
                        aria-pressed={preset.bgSource === s}
                        onClick={() => set('bgSource', s)}
                        style={{ textTransform: 'capitalize' }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                {slider('bgBlur', 'Blur', 0, 20, 0.5, (v) => v.toFixed(1))}
                {slider('bgDarken', 'Darken', 0, 0.9, 0.01, (v) => `${Math.round(v * 100)}%`)}
                {slider('bgZoom', 'Zoom', 1, 2, 0.01, (v) => `${v.toFixed(2)}×`)}
                {slider('bgSaturation', 'Saturation', 0, 2, 0.05, (v) => `${v.toFixed(2)}×`)}
              </>,
            )}

            {section(
              'Frame',
              <>
                {slider('cornerRadius', 'Corner radius', 0, 20, 0.1, (v) => v.toFixed(1))}
                {slider('shadowBlur', 'Shadow softness', 0, 30, 0.5, (v) => v.toFixed(1))}
                {slider('shadowOpacity', 'Shadow strength', 0, 1, 0.01, (v) =>
                  `${Math.round(v * 100)}%`,
                )}
                {slider('shadowOffsetY', 'Shadow drop', 0, 10, 0.1, (v) => v.toFixed(1))}
                {slider('borderOpacity', 'Hairline border', 0, 1, 0.01, (v) =>
                  `${Math.round(v * 100)}%`,
                )}
              </>,
            )}

            {section(
              'Labels',
              <>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={preset.showLabels}
                    onChange={(e) => set('showLabels', e.target.checked)}
                  />
                  <span>Show BEFORE / AFTER labels</span>
                </label>
                {preset.showLabels && (
                  <>
                    <div className="grid-2">
                      <label className="field">
                        <span className="field-label">Before text</span>
                        <input
                          className="text-input"
                          value={preset.beforeLabel}
                          onChange={(e) => set('beforeLabel', e.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">After text</span>
                        <input
                          className="text-input"
                          value={preset.afterLabel}
                          onChange={(e) => set('afterLabel', e.target.value)}
                        />
                      </label>
                    </div>
                    {slider('labelSize', 'Size', 1, 8, 0.1, (v) => v.toFixed(1))}
                    {slider('labelOpacity', 'Opacity', 0.2, 1, 0.01, (v) =>
                      `${Math.round(v * 100)}%`,
                    )}
                  </>
                )}
              </>,
            )}

            {section(
              'Watermark',
              <>
                <label className="field">
                  <span className="field-label">Text</span>
                  <input
                    className="text-input"
                    value={preset.watermarkText}
                    placeholder="@yourshop"
                    onChange={(e) => set('watermarkText', e.target.value)}
                  />
                </label>

                <div className="field">
                  <span className="field-label">
                    Logo <span className="dim">— replaces the text</span>
                  </span>
                  <input
                    ref={logoInput}
                    type="file"
                    accept="image/png,image/svg+xml,image/webp,image/jpeg"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) readLogo(f)
                      e.target.value = ''
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button className="btn sm" onClick={() => logoInput.current?.click()}>
                      <Icon name="upload" size={15} />
                      {preset.watermarkLogo ? 'Replace' : 'Upload logo'}
                    </button>
                    {preset.watermarkLogo && (
                      <>
                        <img
                          src={preset.watermarkLogo}
                          alt="Logo"
                          style={{ height: 28, borderRadius: 4 }}
                        />
                        <button
                          className="btn ghost sm"
                          onClick={() => set('watermarkLogo', null)}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {preset.watermarkLogo &&
                  slider('watermarkLogoScale', 'Logo size', 4, 40, 0.5, (v) => `${v}%`)}
                {!preset.watermarkLogo &&
                  preset.watermarkText &&
                  slider('watermarkSize', 'Text size', 1, 6, 0.1, (v) => v.toFixed(1))}
                {(preset.watermarkLogo || preset.watermarkText) &&
                  slider('watermarkOpacity', 'Opacity', 0.1, 1, 0.01, (v) =>
                    `${Math.round(v * 100)}%`,
                  )}
              </>,
            )}

            {section(
              'Quality',
              <>
                {slider('exportSize', 'Resolution', 1000, 3200, 100, (v) => `${v}px`)}
                {slider('jpegQuality', 'JPEG quality', 0.6, 1, 0.01, (v) =>
                  `${Math.round(v * 100)}%`,
                )}
                <p className="tiny dim">
                  2000px at 92% is the sweet spot for Instagram — bigger files get
                  re-compressed on upload anyway.
                </p>
              </>,
            )}

            <div className="section" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn sm"
                onClick={() => {
                  const name = prompt('Name this look', 'My look')?.trim()
                  if (name) onSavePreset(name)
                }}
              >
                <Icon name="plus" size={15} />
                Save as preset
              </button>
              <button
                className="btn ghost sm"
                onClick={() => {
                  if (confirm('Reset all style settings to the defaults?')) {
                    onChange(DEFAULT_PRESET)
                  }
                }}
              >
                <Icon name="undo" size={15} />
                Reset to defaults
              </button>
            </div>
          </div>
        </div>
      </main>

      <div className="actionbar">
        <div className="actionbar-inner">
          <button className="btn primary block" onClick={onNext}>
            Export
            <Icon name="chevronRight" size={16} />
          </button>
        </div>
      </div>
    </>
  )
}

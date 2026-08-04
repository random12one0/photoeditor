import { useMemo, useState } from 'react'
import { DEFAULT_PRESET } from '../lib/render'
import type { Group, OutputRatio, Photo, StylePreset } from '../types'
import PairPreview from './PairPreview'

interface Props {
  groups: Group[]
  photoMap: Map<string, Photo>
  preset: StylePreset
  onChange: (p: StylePreset) => void
  onNext: () => void
}

interface SamplePair {
  before: Photo
  after: Photo
  groupName: string
}

const RATIO_OPTIONS: { value: OutputRatio; label: string; hint: string }[] = [
  { value: '4:5', label: '4:5', hint: 'Instagram feed' },
  { value: '1:1', label: '1:1', hint: 'Square' },
  { value: '9:16', label: '9:16', hint: 'Story / Reel' },
  { value: '3:4', label: '3:4', hint: 'Classic portrait' },
]

export default function StyleView({ groups, photoMap, preset, onChange, onNext }: Props) {
  const [sampleIndex, setSampleIndex] = useState(0)

  const samples = useMemo<SamplePair[]>(() => {
    const out: SamplePair[] = []
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

  const slider = (
    key: keyof StylePreset,
    label: string,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string = (v) => String(v),
  ) => (
    <label className="field" key={key}>
      <span>
        {label} <strong>{format(preset[key] as number)}</strong>
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

  return (
    <div className="view style-view">
      <div className="view-head">
        <div>
          <h2>Style</h2>
          <p className="muted">
            Set this once. Every export uses it, and it's remembered next time.
          </p>
        </div>
        <div className="head-actions">
          <button
            className="btn ghost"
            onClick={() => {
              if (confirm('Reset all style settings to defaults?')) onChange(DEFAULT_PRESET)
            }}
          >
            Reset
          </button>
          <button className="btn primary" onClick={onNext}>
            Export →
          </button>
        </div>
      </div>

      <div className="style-layout">
        <div className="style-preview">
          {sample ? (
            <>
              <PairPreview
                before={sample.before}
                after={sample.after}
                preset={preset}
                maxWidth={320}
              />
              <div className="preview-nav">
                <button
                  className="btn ghost"
                  disabled={sampleIndex === 0}
                  onClick={() => setSampleIndex((i) => Math.max(0, i - 1))}
                >
                  ←
                </button>
                <span className="tiny muted">
                  {sampleIndex + 1} / {samples.length} · {sample.groupName}
                </span>
                <button
                  className="btn ghost"
                  disabled={sampleIndex >= samples.length - 1}
                  onClick={() =>
                    setSampleIndex((i) => Math.min(samples.length - 1, i + 1))
                  }
                >
                  →
                </button>
              </div>
            </>
          ) : (
            <p className="muted">
              No pairs yet — confirm some on the Pairs screen to see a preview.
            </p>
          )}
        </div>

        <div className="style-controls">
          <fieldset>
            <legend>Output</legend>
            <div className="ratio-row">
              {RATIO_OPTIONS.map((r) => (
                <button
                  key={r.value}
                  className={`ratio-btn${preset.ratio === r.value ? ' active' : ''}`}
                  onClick={() => set('ratio', r.value)}
                >
                  <strong>{r.label}</strong>
                  <span className="tiny muted">{r.hint}</span>
                </button>
              ))}
            </div>
            {slider('exportSize', 'Resolution', 1000, 3200, 100, (v) => `${v}px`)}
            {slider('jpegQuality', 'JPEG quality', 0.6, 1, 0.01, (v) =>
              `${Math.round(v * 100)}%`,
            )}
          </fieldset>

          <fieldset>
            <legend>Background</legend>
            <div className="seg-row">
              {(['before', 'after', 'blend'] as const).map((s) => (
                <button
                  key={s}
                  className={`seg${preset.bgSource === s ? ' active' : ''}`}
                  onClick={() => set('bgSource', s)}
                >
                  {s}
                </button>
              ))}
            </div>
            {slider('bgBlur', 'Blur', 0, 20, 0.5, (v) => `${v}`)}
            {slider('bgDarken', 'Darken', 0, 0.9, 0.01, (v) => `${Math.round(v * 100)}%`)}
            {slider('bgZoom', 'Zoom', 1, 2, 0.01, (v) => `${v.toFixed(2)}×`)}
            {slider('bgSaturation', 'Saturation', 0, 2, 0.05, (v) => `${v.toFixed(2)}×`)}
          </fieldset>

          <fieldset>
            <legend>Layout</legend>
            {slider('padding', 'Outer margin', 0, 18, 0.2, (v) => `${v}%`)}
            {slider('gap', 'Gap between photos', 0, 15, 0.2, (v) => `${v}%`)}
            <div className="seg-row">
              {(['cover', 'contain'] as const).map((m) => (
                <button
                  key={m}
                  className={`seg${preset.fitMode === m ? ' active' : ''}`}
                  onClick={() => set('fitMode', m)}
                >
                  {m === 'cover' ? 'Crop to match' : 'Fit whole photo'}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>Photo frame</legend>
            {slider('cornerRadius', 'Corner radius', 0, 10, 0.1, (v) => `${v}`)}
            {slider('shadowBlur', 'Shadow softness', 0, 15, 0.1, (v) => `${v}`)}
            {slider('shadowOpacity', 'Shadow strength', 0, 1, 0.01, (v) =>
              `${Math.round(v * 100)}%`,
            )}
            {slider('shadowOffsetY', 'Shadow drop', 0, 6, 0.1, (v) => `${v}`)}
            {slider('borderWidth', 'Border width', 0, 1, 0.02, (v) => `${v.toFixed(2)}`)}
            {slider('borderOpacity', 'Border strength', 0, 1, 0.01, (v) =>
              `${Math.round(v * 100)}%`,
            )}
          </fieldset>

          <fieldset>
            <legend>Labels</legend>
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
                <label className="field">
                  <span>Before text</span>
                  <input
                    className="text-input"
                    value={preset.beforeLabel}
                    onChange={(e) => set('beforeLabel', e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>After text</span>
                  <input
                    className="text-input"
                    value={preset.afterLabel}
                    onChange={(e) => set('afterLabel', e.target.value)}
                  />
                </label>
                {slider('labelSize', 'Label size', 1, 6, 0.1, (v) => `${v}`)}
                {slider('labelOpacity', 'Label opacity', 0.2, 1, 0.01, (v) =>
                  `${Math.round(v * 100)}%`,
                )}
              </>
            )}
          </fieldset>

          <fieldset>
            <legend>Watermark</legend>
            <label className="field">
              <span>Text (leave blank for none)</span>
              <input
                className="text-input"
                value={preset.watermarkText}
                placeholder="@yourshop"
                onChange={(e) => set('watermarkText', e.target.value)}
              />
            </label>
            {preset.watermarkText && (
              <>
                {slider('watermarkSize', 'Size', 1, 5, 0.1, (v) => `${v}`)}
                {slider('watermarkOpacity', 'Opacity', 0.1, 1, 0.01, (v) =>
                  `${Math.round(v * 100)}%`,
                )}
              </>
            )}
          </fieldset>
        </div>
      </div>
    </div>
  )
}

# v1.0.0 — before/after batch editor

Batch before/after photo editor for car detailing. Drop in a day's camera roll, and it sorts the photos into cars, proposes which shots are before/after pairs, and exports finished composites — straight to Instagram from a phone, or as a ZIP with one folder per car.

Everything runs in the browser. No account, no server, no upload, no cost, and the photos never leave the device.

## What it does

- **Groups photos by car** from the shape of the day, without needing anything tagged.
- **Proposes before/after pairs**, ranked so the easy yeses come first.
- **One tap or one key per decision** — swipe the card, press a button, or use the keyboard.
- **Style it once.** Ratio, background blur and darkness, margins, gap, corner radius, shadow, labels, watermark or logo. Saved as named presets.
- **Export** to the share sheet or a ZIP. Unpaired photos still land in their car's folder, untouched.

## How the matching works, and what it cost to learn

Two designs were built against synthetic fixtures, scored 100% on them, and then failed completely on real photographs.

The assumption underneath both was that a before and an after are the same framing, so cross-correlation would identify pairs almost perfectly. Measured on real detailing photos, true pairs score **-0.10 to 0.43** while unrelated photos of different cars reach **0.27** — near-total overlap. Nobody stands in the same spot ninety minutes later.

A second mistake was conflating two questions. Structure answers *same framing*, and that is exactly what two **different** cars share when photographed from the same spot: on the bay fixtures a different car at the same angle correlates as strongly as a true pair does. Car identity leans on exposure-invariant chromaticity instead, because paint colour survives a wash.

What replaced them uses the clock as its backbone — burst detection scaled to each roll's own median gap, cars assembled by dynamic programming over boundary contrast, pairs matched on walk-around order plus visual similarity — with suggestions **ranked, never gated**. A threshold tuned on real data would either admit everything or reject everything.

## Measured

Across eight adversarial synthetic scenarios (back-to-back cars, six identical silver cars, missing EXIF, mixed orientation, before-only jobs, a 156-photo day, handheld drift) and on real photographs, **precision is 100% — it has not yet proposed a wrong pair.** Where the input is genuinely ambiguous it under-merges and asks rather than guessing, which costs one tap; guessing would cost a wrong export.

## Notes

- Built mobile-first: navigation at the top because it's used rarely, the two verdict buttons in the thumb zone because they're pressed on every photo, 48px targets with 56px primaries.
- Canvases are pooled. iOS Safari caps total canvas memory near 384MB and retains backing stores after collection; allocating per operation took the tab down partway through a large import.
- Installs to a phone home screen and works offline.

## Deploying

A GitHub Pages workflow is included and runs on every push; enable it once at **Settings → Pages → Source → GitHub Actions**. `netlify.toml` is also ready if you prefer Netlify — import the repository in their UI and it needs no configuration.

# unbklok

A batch before/after photo editor for car detailing. Drop in a day's camera
roll: it sorts the photos into cars, proposes which shots are before/after
pairs, and exports finished composites — shared straight to Instagram from a
phone, or as a ZIP with one folder per car.

Everything runs in the browser. No account, no server, no upload, no cost.

## Why there's no backend

The photos never leave the device. That isn't a privacy slogan, it's the
architecture:

- **It's free to host, permanently.** A static site has no storage or bandwidth
  bill. A server that ingests hundreds of full-resolution phone photos does.
- **It's faster.** Nothing is uploaded, so a 150-photo batch starts processing
  immediately.
- **It works offline** and installs to a phone home screen as a PWA.

The trade-off is real and worth stating: there's no sync between devices. A
session started on a phone lives on that phone. Work is saved to IndexedDB, so
it survives a reload or a tab eviction, but not a change of device.

No AI is involved anywhere, and none is needed.

## What the photos actually taught us

The interesting problem is deciding which photos belong to which car, and which
pairs are the same shot before and after. Two designs were built against
synthetic fixtures, scored 100% on them, and then failed completely on real
photographs. The measurements are in `test/diagnose-real.mjs` and are worth
reading before changing `src/lib/cluster.ts`.

**A perceptual hash is not enough.** On the fixtures, dHash distance for true
pairs ran 18–31 while unrelated photos of different cars ran 11–45 — almost
complete overlap.

**Neither is cross-correlation, on its own.** The obvious fix — a
contrast-normalised luminance grid compared by cross-correlation — scored 0.75
to 0.98 on true pairs against a ceiling of 0.54 for everything else. On the
fixtures. On real detailing photos the same measurement gives **-0.10 to 0.43
for true pairs, against 0.27 for unrelated shots**. The assumption underneath
it was simply wrong: a before and an after are *not* the same framing. Nobody
stands in the same spot ninety minutes later, and the reshoot is often from a
visibly different distance and angle.

**"Same framing" and "same car" are different questions.** Structure answers the
first. It actively misleads on the second: two *different* cars photographed
from the same spot correlate as strongly as a true pair does (0.957–0.997 vs
0.96–0.98). Paint colour is what persists across a wash and differs between
cars, so car identity leans on exposure-invariant chromaticity instead.

So the design that survived contact with real photos uses the clock as its
backbone and treats vision as a ranking signal, never a gate:

1. **Bursts.** Photos cluster into walk-arounds. The threshold is derived from
   the roll's own median gap rather than fixed — a fixed twenty minutes welds
   one car's after shots to the next car's before shots in any shop with a
   nineteen-minute turnaround, and no downstream cleverness recovers from bursts
   that are already wrong.
2. **Cars.** Bursts pair up into cars by dynamic programming over the sequence.
   Each boundary is scored by *local contrast* — a boundary inside a car scores
   higher than the boundaries either side of it — because every global threshold
   tried helped one scenario and broke another. A small time term breaks ties
   the pixels can't.
3. **Pairs.** Inside a car, the widest internal pause splits before from after,
   and shots are matched on walk-around order plus visual similarity. People
   walk around a car the same way twice, and that prior is worth more than the
   pixels here.

Suggestions are **ranked, never filtered**. A gate tuned on real data would
either admit everything or reject everything, so the app orders them by
confidence and asks — which costs one tap each and is honest about what it
knows.

## Measured accuracy

Two suites. `npm run test:accuracy` scores eight adversarial synthetic
scenarios; `npm test:real` runs the whole pipeline over real detailing photos.

| Scenario | Grouping P/R | Pairing P/R |
|---|---|---|
| 8 cars, clean gaps (64 photos) | 100% / 100% | 100% / 100% |
| Cars 25 min apart, back to back | 100% / 100% | 100% / 100% |
| No EXIF, timestamps bunched | 100% / 100% | 100% / 100% |
| Portrait mixed with landscape | 100% / 100% | 100% / 100% |
| Half the jobs never got an after | 100% / 100% | 100% / 100% |
| A 156-photo day, 12 cars | 100% / 100% | 100% / 100% |
| Handheld drift between shots | 100% / 100% | 100% / 100% |
| Six near-identical silver cars | 100% / 81% | 100% / 67% |

The last row is the point, not an embarrassment. Six identical silver cars
through the same bay are genuinely indistinguishable, so the algorithm
**under-merges and asks** rather than guessing. Precision stays at 100%
everywhere: it has never yet proposed a wrong pair in any scenario. Loosening
the threshold lifts that recall and was measured breaking the before-only case
in exchange — over-merging produces confidently wrong exports, and missing a
merge costs one tap.

On the real photographs it finds 4 of 5 cars and 4 of 4 proposed pairs are
correct. The miss is explainable: those fixtures have exactly one photo per
burst, so each decision rests on a single comparison instead of a whole
walk-around, and the car it misses has a wet soapy driveway in the before and a
dry one in the after.

## Using it

1. **Import** — drop in photos or pick them from the camera roll.
2. **Cars** — check the grouping. Rename, merge, split or move photos.
3. **Pairs** — confirm or reject each suggestion. Swipe the card, or use the
   buttons, or:

   | Key | Action |
   |---|---|
   | `→` `Enter` `Y` | Confirm the pair |
   | `←` `X` | Not a pair |
   | `S` | Swap before and after |
   | `Space` | Skip for now |
   | `P` | Toggle the finished preview |
   | `↑` `↓` | Previous / next car |
   | `Ctrl`+`Z` | Undo |

   Anything left unpaired can be matched by tapping one photo then its partner,
   and still exports with its car.
4. **Style** — set the look once, with a live preview. Save named presets.
5. **Export** — share sheet straight to Instagram or Photos, or a ZIP.

## Design notes

The defaults were measured from the user's own hand-made collages rather than
guessed (`npm run test:measure` reproduces it): 8.7% side margins, 4.7% top and
bottom, 0.47% corner radius, a heavy lightly-darkened blur behind. Two things
that measurement caught which guessing had got backwards — the **finished car
goes on top**, and the two photos **keep their own aspect ratios** instead of
being cropped to a shared frame.

The interface is monochrome with colour reserved for meaning: green confirms,
red rejects, nothing else is tinted. In a screen full of photographs, chrome
that competes for attention gets in the way.

Layout follows the research on one-handed use: navigation lives at the top
because it's used rarely, and the actions pressed on every single photo live in
the thumb zone at the bottom. Touch targets are 48px minimum and 56px for the
two verdict buttons, per Google's finding that accuracy holds above 95% at 48dp
and 98–99% at 56dp. Swipe is an accelerator layered on top of the buttons, never
the only route — NN/G is clear that swipe-only actions aren't discoverable.

Every spatial value in a style preset is a percentage of canvas width, so the
320px preview and the 2000px export are proportionally identical.

Canvases are pooled rather than allocated per operation. iOS Safari caps total
canvas memory around 384MB and is notorious for holding backing stores after
the JS object is unreachable; allocating per call meant three per imported photo
plus two per preview repaint, which takes the tab down partway through a large
import.

## Development

```bash
npm install
npm run dev              # dev server
npm run build            # production build to dist/
npm run typecheck

npm test                 # end-to-end: import → group → pair → style → export → reload
npm run test:real        # the whole pipeline over real detailing photos
npm run test:accuracy    # precision/recall across 8 adversarial scenarios
npm run test:diagnose    # distance distributions on synthetic fixtures
npm run test:diagnose:real  # …and on real photos. Run before touching a threshold.
npm run test:measure     # re-measure reference collages, re-cut their panels
npm run test:shots       # screenshots and a sample composite into test/output/
```

The tests drive a real browser through the real UI and inspect the actual ZIP
that comes out — file count, folder layout, and the pixel dimensions of the
JPEGs inside. They target `data-view` / `data-testid` hooks rather than CSS
classes, so restyling can't break them.

`test/fixtures/reference/` and `test/fixtures/photos/` are deliberately
gitignored: they're real photographs of real cars, license plates included, and
they don't belong in a public repository.

### Layout

```
src/lib/hash.ts        fingerprinting — luma grids, chromaticity, dHash, shifted NCC
src/lib/cluster.ts     burst detection, car grouping, pair suggestion
src/lib/render.ts      the composite renderer
src/lib/exporter.ts    full-resolution rendering, ZIP and share-sheet packing
src/lib/ingest.ts      decode, downscale, EXIF, fingerprint
src/lib/canvasPool.ts  shared scratch canvases
src/lib/db.ts          IndexedDB session persistence
src/lib/share.ts       Web Share API, clipboard, haptics
```

## Deploying

Netlify config is in `netlify.toml` (build `npm run build`, publish `dist`).
Any static host works; the app is entirely client-side.

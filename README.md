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

**Two cars in the same driveway are not visually separable.** A later attempt
used vision to decide where one car ends and the next begins, scoring each
candidate boundary against the run it sits in. Measured against real photos:

```
one car, boundaries that must NOT be cut   0.94, 0.98, 1.12, 1.12, 1.17
five cars, boundaries that MUST be cut     0.94, 1.01, 1.03, 1.08
```

The distributions sit on top of each other, and three of four genuine car
boundaries look *more* alike across the boundary than the photos within a car
do. There is no threshold in there, and pretending otherwise was worse than
doing nothing.

So the design that survives contact with real photos is deliberately plain
about which signal does which job:

1. **Cars are cut on the clock, and only the clock.** A break longer than the
   set gap starts a new car; no car spans more than the set number of hours.
   Both are numbers a person can picture and correct. The honest limitation,
   stated in the settings themselves: two cars finished and started within that
   gap land together and want one tap on Split. That is the right way round — a
   merged car costs one tap, whereas a car shattered into six was the complaint
   that prompted this design.
2. **Pairs are chosen by optimal assignment** (Hungarian, `src/lib/assign.ts`)
   over the whole before/after set, so the result is the best *total* matching
   rather than whatever a greedy first pass grabbed. Greedy commits to the
   best-looking single pair and lets everything downstream settle for the
   leftovers, which is how a wheel ends up married to a centre console.
3. **Walk-around order is off by default.** The idea was sound — people circle a
   car the same way twice — but it assumes the two batches line up, and they
   don't: three before shots against five after shots makes index 1 the console
   rather than the wheel. Measured on a real car, even a 15% weight pulled the
   wheel onto the console. Available to turn up for anyone who really does shoot
   a fixed sequence.
4. **Nothing below the quality floor is proposed.** A leftover photo is left
   unpaired rather than married to the nearest remaining option.

## Measured accuracy

Four suites. `npm run test:assign` checks the assignment solver against brute
force; `npm run test:accuracy` scores eight synthetic workflows; `npm run
test:real` and `npm run test:samecar` run the whole pipeline over real
photographs.

The one that matters most is `test:samecar`, because it is the bug report:
eight photos of a single Jeep across one job, with ground truth established by
looking at every photo. It asserts that the car stays one car, that the wheel
pairs with the wheel, the trunk with the trunk, the exterior with the exterior,
and that the two centre-console shots with no partner are left alone.

| Scenario | Grouping P/R | Pairing P/R |
|---|---|---|
| One Jeep, one job (real photos) | one car | 3/3 exact |
| Five jobs (real photos) | 100% / 100% | 5/5 exact |
| 8 cars, clean gaps (64 photos) | 100% / 100% | 100% / 100% |
| No EXIF, timestamps bunched | 100% / 100% | 100% / 100% |
| Portrait mixed with landscape | 100% / 100% | 100% / 100% |
| Half the jobs never got an after | 100% / 100% | 100% / 100% |
| A 156-photo day, 12 cars | 100% / 100% | 100% / 100% |
| Six near-identical silver cars | 100% / 100% | 100% / 100% |
| Handheld drift between shots | 100% / 100% | 92% / 92% |
| Bay shop, 25-min turnaround | *merges — see below* | *merges* |

Two rows are honest failures rather than passes in disguise, and both are
recorded with explicit tolerances so that any future fix shows up as an
improvement:

**The bay shop** turns cars around in 25 minutes while the job itself takes 60.
No gap threshold can separate those — any value large enough to hold one car
together is larger than the pause before the next one. That workflow needs the
Split button.

**Handheld drift** loses two pairs of twenty-four with walk-around order
switched off. That switch is what stopped a real wheel being married to a real
centre console, and this is the price, paid in a synthetic case where every
angle drifts.


## Using it

1. **Import** — drop in photos or pick them from the camera roll.
2. **Cars** — check the grouping. Rename, merge, split or move photos. Every
   photo shows its capture time, and a `~` means the time was guessed from the
   file rather than read from the photo. Select one photo and tap **Time** to
   correct it; a banner warns when a whole import arrived without capture
   times, because the grouping is only ever as good as they are.
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

npm run test:all         # every suite below, in order
npm test                 # end-to-end: import → group → pair → style → export → reload
npm run test:assign      # the assignment solver against brute force
npm run test:real        # the whole pipeline over real detailing photos
npm run test:samecar     # the bug report: one car, one job, eight real photos
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

`test/fixtures/reference/`, `test/fixtures/photos/` and `test/fixtures/samecar/`
are deliberately gitignored: they're real photographs of real cars, license
plates included, and they don't belong in a public repository. The suites that
need them skip when they're absent, which is why CI runs the synthetic ones
only.

### Layout

```
src/lib/hash.ts        fingerprinting — luma grids, chromaticity, dHash, shifted NCC
src/lib/cluster.ts     car grouping on the clock, pair suggestion
src/lib/assign.ts      optimal one-to-one assignment (Hungarian)
src/lib/render.ts      the composite renderer
src/lib/exporter.ts    full-resolution rendering, ZIP and share-sheet packing
src/lib/ingest.ts      decode, downscale, EXIF, fingerprint
src/lib/canvasPool.ts  shared scratch canvases
src/lib/db.ts          IndexedDB session persistence
src/lib/share.ts       Web Share API, clipboard, haptics
```

## Deploying

Everything is wired up; both routes need one switch flipped by hand, because
neither can be enabled through an API from a sandbox.

`npm run build:single` produces `dist-single/index.html` — the whole app inlined
into one self-contained file, which can be opened straight off disk or dropped
on any host with no build step at all.

**GitHub Pages** — `.github/workflows/deploy.yml` builds and publishes on every
push to the default branch. Enable it once at
**Settings → Pages → Source → GitHub Actions**, then re-run the workflow. The
site lands at `https://<user>.github.io/<repo>/`.

**Netlify** — `netlify.toml` already carries the build command and publish
directory, so **Add new site → Import an existing project → GitHub** picks it up
with nothing to configure. (Deploying through Netlify's build API from CI was
attempted and returns 403 for this account; connecting the repository in the UI
avoids that path entirely.)

Any static host works — the app is entirely client-side, so `npm run build` and
serving `dist/` is the whole deployment.

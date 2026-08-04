# unbklok

A batch before/after photo editor for car detailing. Drop in a day's camera
roll, and it sorts the photos into cars, works out which shots are before/after
pairs, and exports finished composites — one folder per car.

Everything runs in the browser. No account, no server, no upload, no cost.

## Why there's no backend

The photos never leave the device. That isn't a privacy slogan, it's the
architecture:

- **It's free to host, permanently.** A static site has no storage or bandwidth
  bill. A server that ingests hundreds of full-resolution phone photos does.
- **It's faster.** There's no upload wait, because nothing is uploaded. A
  150-photo batch starts processing immediately.
- **It works offline** and installs to a phone home screen as a PWA.

The trade-off is real and worth stating: there's no sync between devices. A
session started on a phone lives on that phone. Work is saved to IndexedDB, so
it survives a reload or a tab eviction, but not a change of device.

No AI is involved anywhere, and none is needed — see below.

## How the matching works

The interesting problem is deciding which photos belong to which car, and which
pairs are the same shot before and after.

The obvious approach — cluster into cars first, then find pairs inside each car
— was built, measured, and thrown away. **Grouping is the weak signal.** Every
car is photographed in the same bay from the same handful of angles, so two
different cars look far more alike than two angles of the same car do. Cluster
on that and the whole day fuses into one blob (measured: six cars collapsing
into a single group).

**Pairing is the strong signal.** A before and an after are the same framing of
the same scene, and that is easy to detect reliably. So the order is inverted:
pairs are found first, across the whole roll, and then they decide the grouping.

Three cheap descriptors do the work, each covering the others' blind spot:

| Descriptor | What it is | What it's for |
|---|---|---|
| **Normalised luma grid** | 16×16 contrast-normalised luminance, compared by cross-correlation | The main signal. Invariant to brightness and contrast changes, which is most of what cleaning a car does to a photo. |
| **Chromaticity signature** | 4×4 grid of `r/(r+g+b)`, `g/(r+g+b)` | Tells a red car from a blue one. Exposure-invariant, so a filthy red car still reads as the same red as a gleaming one. |
| **dHash** | 64-bit difference hash | A small amount of independent structural evidence. |

A perceptual hash on its own is not enough, and the numbers say so. Measured
across the test fixtures, dHash distance for *true pairs* ranged 18–31 while
*unrelated photos of different cars* ranged 11–45 — almost complete overlap.
Cross-correlation separates the same cases cleanly: 0.75–0.98 for true pairs
against a ceiling of 0.54 for everything else.

Two rules keep false pairs out:

- **Mutual-best matching with a ratio test.** A pair is accepted only if each
  shot is the other's best candidate *and* that candidate is clearly better than
  the runner-up. When six silver cars go through the same bay, every candidate is
  ambiguous, so the ratio test refuses them all and asks you to pair by hand —
  the honest answer, because nothing in those pixels distinguishes those cars.
- **Pairs must span separate bursts.** A before and an after are separated by the
  actual work. Two frames shot ten seconds apart are two angles, never a pair.

Grouping then falls out of the pairs: two pairs belong to the same car when their
before shots were taken close together *and* their after shots were too. Photos
the matcher never paired — extra angles, detail shots, jobs that never got an
after — join whichever car they were shot alongside, and still land in that car's
folder.

## Measured accuracy

`npm run test:accuracy` scores the algorithm against synthetic camera rolls built
to break it. Every car is drawn in the same shop bay with the same fittings, so
the fixtures don't hand the matcher an easy win.

| Scenario | Grouping P/R | Pairing P/R |
|---|---|---|
| 8 cars, clean gaps (64 photos) | 100% / 100% | 100% / 100% |
| Cars 25 min apart, back to back | 100% / 100% | 100% / 100% |
| Six near-identical silver cars | 100% / 100% | 100% / 100% |
| No EXIF, timestamps bunched | 100% / 100% | 100% / 100% |
| Portrait mixed with landscape | 100% / 100% | 100% / 100% |
| Half the jobs never got an after | 100% / 100% | 100% / 100% |
| A 156-photo day, 12 cars | 100% / 100% | 100% / 100% |
| Handheld drift between before and after | 100% / 100% | 100% / 100% |

These are synthetic fixtures, not real photographs, so treat them as evidence
the logic is sound rather than a promise about your camera roll. The thresholds
they produced are all adjustable in the app under *Cars → Grouping settings*.

## Using it

1. **Import** — drop in photos or pick them from the camera roll.
2. **Cars** — check the grouping. Rename, merge, split or move photos.
3. **Pairs** — confirm or reject the suggestions. One key or one tap each:

   | Key | Action |
   |---|---|
   | `→` `Enter` `Y` | Confirm the pair |
   | `←` `X` | Reject it |
   | `S` | Swap which one is the "before" |
   | `Space` | Skip for now |
   | `P` | Toggle the finished preview |
   | `↑` `↓` | Previous / next car |

   On a phone the same actions are large buttons. Anything left unpaired can be
   matched by tapping one photo then its partner.
4. **Style** — set the look once, with a live preview. Ratio, background blur and
   darkness, margins, gap, corner radius, shadow, border, labels, watermark.
5. **Export** — one ZIP, one folder per car, composites inside, unpaired
   originals in a `singles` subfolder.

## Development

```bash
npm install
npm run dev            # dev server
npm run build          # production build to dist/
npm run typecheck

npm test               # end-to-end: import → group → pair → style → export → reload
npm run test:accuracy  # grouping and pairing precision/recall across 8 scenarios
npm run test:diagnose  # distance distributions, for setting thresholds from data
npm run test:shots     # screenshots and a sample composite into test/output/
```

The tests drive a real browser through the real UI with generated camera rolls,
and check the actual ZIP that comes out — file count, folder layout, and the
pixel dimensions of the JPEGs inside.

`test/diagnose.mjs` is the one to run before touching any threshold. It prints
how far apart the categories actually are, so the constants in
`src/lib/cluster.ts` stay grounded in measurements rather than taste.

### Layout

```
src/lib/hash.ts     fingerprinting — luma grid, chromaticity, dHash, NCC
src/lib/cluster.ts  pair matching and car grouping
src/lib/render.ts   the composite renderer
src/lib/exporter.ts full-resolution rendering and ZIP packing
src/lib/ingest.ts   decode, downscale, EXIF, fingerprint
src/lib/db.ts       IndexedDB session persistence
```

Every spatial value in a style preset is a percentage of canvas width, so the
320px preview and the 2000px export are proportionally identical — what the
editor shows is what lands in the ZIP.

## Deploying

Netlify config is in `netlify.toml` (build `npm run build`, publish `dist`).
Any static host works; the app is entirely client-side.

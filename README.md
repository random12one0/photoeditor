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

**Averaging colour throws away the thing that separates a wheel from a car
boot.** Reported as interiors being confused with wheels. The chromaticity
signature takes the *mean* colour of each cell, which answers "what colour is
this region" — and a wheel on grass averages to much the same grey-green as a
grey boot carpet. Measured on real photographs, a dirty wheel scored higher
against a clean boot than against the same wheel washed.

A histogram answers a better question: does this photo contain any of this
colour at all? That is Swain and Ballard's colour indexing, compared by
histogram intersection, chosen because it degrades gracefully when a scene is
reframed — which is exactly what happens between a before and an after taken
hours apart from a slightly different spot.

The user's own diagnosis was that an outdoor shot has green in it and an
interior has none. Right in principle, and it is why the histogram is there —
but on this particular pair it did not break the tie, because the boot was
photographed with the hatch open: there is grass through the rear window and a
green box in the side netting. Colour alone still preferred the boot by 0.006.

**Texture is what actually separated them.** An edge histogram — MPEG-7's, near
enough: gradient orientations in a 4×4 grid plus a global summary — was the only
term that got that pair right, by 0.06. A tyre is dense tread and radial spokes;
a boot is flat carpet. Two independent reasons to separate two subjects is the
point, because the failure being fixed was two different things agreeing on one
weak signal.

**The luma grids are gone from pair scoring.** Cross-correlating a
contrast-normalised grid was the backbone of this function and, measured, it is
the weakest signal on real photographs: on its own it wins 2 of 4 rows on one
set and 3 of 5 on the other. It assumes a before and an after are the same
framing and they are not. It stays in `sameTakeScore`, where two shots really
are seconds apart and the assumption holds.

Weights were chosen by measurement, not argument. `npm run
test:diagnose:descriptors` scores seventeen candidates against both sets of real
photographs and prints the table. The measure that matters is *row wins* — for
each before shot, does its true partner beat every impostor? — because a global
assignment can rescue a row that loses, which is how a weak descriptor stays
hidden until the day it doesn't.

```
candidate                    Jeep rows  Jeep pairs  ref rows  ref pairs  min margin
current (before this change)       3/4         4/4       4/5        5/5      -0.036
structure only                     2/4         4/4       3/5        2/5      -0.079
colour histogram only              3/4         4/4       4/5        5/5      -0.006
edge histogram only                4/4         4/4       4/5        5/5      -0.062
colour + edge + dHash              4/4         4/4       5/5        5/5      +0.009
```

The last row is what ships, and it is the only candidate where every true pair
beats every impostor on both sets rather than merely winning on aggregate. It
also lifted the synthetic handheld-drift scenario from 92% to 100%, which had
been a documented failure.

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
   Both are numbers a person can picture and correct. The gap defaults to five
   hours because of how the photos are actually taken — every before shot first,
   then the detail, then every after shot when the work is done, around four
   hours later. A threshold at or below that cuts the befores away from the
   afters and turns one car into two. The honest limitation, stated in the
   settings themselves: two cars finished and started within that gap land
   together and want one tap on Split. That is the right way round — a merged
   car costs one tap, whereas a car shattered into six was the complaint that
   prompted this design.
2. **Pairs are chosen by optimal assignment** (Hungarian, `src/lib/assign.ts`)
   over the whole before/after set, so the result is the best *total* matching
   rather than whatever a greedy first pass grabbed. Greedy commits to the
   best-looking single pair and lets everything downstream settle for the
   leftovers, which is how a wheel ends up married to a centre console. The
   contract is maximum cardinality first, minimum cost second — see the note on
   unbalanced sets below, because getting that order wrong is subtle and cost a
   real pair.
3. **Walk-around order is off by default.** The idea was sound — people circle a
   car the same way twice — but it assumes the two batches line up, and they
   don't: three before shots against five after shots makes index 1 the console
   rather than the wheel. Measured on a real car, even a 15% weight pulled the
   wheel onto the console. Available to turn up for anyone who really does shoot
   a fixed sequence.
4. **Nothing below the quality floor is proposed.** A leftover photo is left
   unpaired rather than married to the nearest remaining option.
5. **Three shots of one angle count as one.** They're collapsed before matching
   and the sharpest survives — see below.

**Shooting one angle three times is normal, and it needs an answer.** Three
before shots against one after isn't a matching problem: two of those three
never had a partner. Handing all three to the matcher means it pairs whichever
happens to correlate best with the after, and among three shots of one subject
that difference is noise — it could just as easily return the blurred one. So
near-identical takes are collapsed first and the sharpest wins, measured as
gradient energy over contrast. Dividing by contrast is what stops it preferring
a cluttered driveway to a clean one. Against real photographs degraded in known
ways, the untouched shot beats the degraded one 38 times out of 40.

The two it loses are worth stating: a uniformly darkened copy ties with the
original, because the measure is immune to a linear brightness change by
construction. It ranks focus, not exposure — and between three shots taken
seconds apart, exposure is identical anyway.

Deciding *what counts as the same take* took two attempts. The first reused the
general similarity score, which is deliberately blind to translation, because a
photographer returning ninety minutes later doesn't stand in the same footprint.
That tolerance is exactly wrong here: two takes of one angle differ by a small
drift and two framings of one car differ by a large one, and a metric that
discards translation can't tell them apart. It collapsed four distinct angles
into one and cost seven of nine scenarios most of their pairing recall.

The replacement compares the fine grid where it lies, with no shift search. It
separates on both photo sources — but not at the same threshold:

```
                          same take (min)   different angle (max)
real photographs                    0.737                   0.630
synthetic fixtures                  0.822                   0.745
```

No single number fits inside both, and the fixtures win that argument — two
shots of one composition at slightly different distances is a thing people do.
The clock settles it. Shooting one angle three times is a single act that takes
seconds, while moving to the next angle takes longer, so the window is 90
seconds and both gates must pass. The fixtures' angles are two minutes apart and
never collapse whatever they score, which leaves the threshold free to sit in
the 0.1-wide gap the real photographs actually have.

The losers aren't discarded. They're offered on the pair as a strip of
thumbnails — tap one to swap it in — and still export with their car.

**More before shots than after shots is where the solver was wrong.** Reported
as interiors pairing badly, and the diagnosis is worth keeping because the
symptom pointed away from the cause. On a real nine-photo job — five before
shots, four after — the three exterior pairs came out exact and the interior did
not: the dirty console lost its own clean console, and the driver's seat, which
had no partner anywhere in the set, took it instead.

The scores were fine. The dirty console's best match in its own row *was* the
clean console, and the correct assignment scored 2.940 against the 2.869 that
came out. The solver returned a worse answer than the right one, which is the
one thing an optimal algorithm may not do.

The shortest-augmenting-path formulation walks the rows in order. With more rows
than columns some row must go unassigned, and it gives up on whichever row it
reaches with no free column left — so *which* row loses is decided by position
rather than by cost. The last before shot was dropped instead of the worst one.
Transposing when there are more rows than columns puts the short side on the
rows, where every row genuinely can be assigned and the optimisation decides
which columns miss out.

Worth stating plainly: `npm run test:assign` had been comparing the solver
against a brute-force reference for 300 random matrices, including this shape,
and reported no mismatches. The reference forced the *first* `cols` rows to be
assigned — exactly the same wrong assumption as the solver. Two implementations
agreeing with each other is not a test. With the reference fixed to enumerate
which rows are used, 127 of 171 tall matrices were wrong.

**The ground truth was also wrong, in the direction that hides a bug.** The two
centre-console frames were recorded as having no partner and the suite asserted
they must be left alone — so the suite was demanding the failure it existed to
catch. They are a genuine pair: the console dusty, then the console wiped. What
each frame shows now lives in one place, `test/lib/samecar-truth.mjs`, with the
subject of every photograph written down, because a ground truth spread across
three files is three places to be wrong.

Interiors themselves turned out not to need special handling. Once the solver
was fixed the console pair came out exact, and `npm run test:diagnose:interior`
prints the whole score matrix per component if that stops being true.

**Local feature matching was built, measured, and left out.** Asked for as
"something that could recognize shapes or objects... not just colour, but
pattern", which is exactly ORB: FAST corners, oriented BRIEF descriptors, and
RANSAC geometric verification — "do forty-one specific points agree on one
single camera movement". `src/lib/features.ts` implements it; `npm run
test:diagnose:features` scores it.

It does something no global descriptor can. On the Jeep set the true trunk pair
agrees on 69 points and the true console pair on 29, where every impostor
manages 7 or fewer — and the driver's seat, which has no partner at all, reaches
a maximum of 5 against anything. That last number is a kind of evidence the
global scores simply cannot produce.

It still loses. On both sets of real photographs, every weighting that includes
it does worse than what already ships:

```
candidate                    Jeep rows  ref rows  min margin
global (shipping)                  4/4       5/5      +0.009
features only                      3/4       3/5      -0.154
features + global, even            4/4       4/5      -0.058
global + features 15%              4/4       5/5      +0.008
```

The reason is visible in the inlier counts: features are superb on close-ups
with hard structure and poor on whole-car exteriors, where the paint changes
from dull to glossy and the background moves. Adding a scale pyramid tripled the
counts on close-ups — the trunk went from 38 to 69 — and made the exteriors
slightly worse, because impostors gained too.

So it is kept, documented and measurable, but not wired into scoring. Nothing in
`src/` imports it, so it isn't in the bundle. If a set of photographs turns up
that the current approach gets wrong and this one gets right, the harness is
already there to prove it.

## Measured accuracy

Eleven suites. `npm run test:assign`, `npm run test:readahead` and `npm run
test:decode` check the assignment solver, the import read-ahead and the proxy
decode directly; `npm run test:accuracy`
scores eight synthetic workflows; `npm run test:real`, `npm run test:samecar`,
`npm run test:takes`, `npm run test:handpair`, `npm run test:runnerup` and `npm
run test:stale` run the whole pipeline over real photographs.

`test:stale` earns its place: it is the only one that starts from a *saved*
session rather than a fresh import, which is the one thing every other suite was
structurally unable to check — and where a real bug lived undetected.

Ground truth for the real-photo set — which frame shows what, which pairs with
which — is written down once in `test/lib/samecar-truth.mjs` and imported by
every suite that needs it.

The one that matters most is `test:samecar`, because it is the bug report: nine
photos of a single Jeep across one job, with ground truth established by looking
at every photo. It asserts that the car stays one car, that the wheel pairs with
the wheel, the trunk with the trunk, the exterior with the exterior, the dusty
console with the wiped console, and that the driver's seat — shot before, never
shot after — is left alone.

| Scenario | Grouping P/R | Pairing P/R |
|---|---|---|
| One Jeep, one job, 9 real photos | one car | 4/4 exact, incl. the interior pair |
| Same Jeep, every angle shot 3× (real photos) | one car | 4/4 exact, sharpest take |
| Five jobs (real photos) | 100% / 100% | 5/5 exact |
| 8 cars, clean gaps (64 photos) | 100% / 100% | 100% / 100% |
| No EXIF, timestamps bunched | 100% / 100% | 100% / 100% |
| Portrait mixed with landscape | 100% / 100% | 100% / 100% |
| Half the jobs never got an after | 100% / 100% | 100% / 100% |
| A 156-photo day, 12 cars | 100% / 100% | 100% / 100% |
| Six near-identical silver cars | 100% / 100% | 100% / 100% |
| Handheld drift between shots | 100% / 100% | 100% / 100% |
| Bay shop, 25-min turnaround | *merges — see below* | *merges* |

Two rows are honest failures rather than passes in disguise, and both are
recorded with explicit tolerances so that any future fix shows up as an
improvement:

**The bay shop** turns cars around in 25 minutes while the job itself takes 60.
No gap threshold can separate those — any value large enough to hold one car
together is larger than the pause before the next one. That workflow needs the
Split button.

**Handheld drift** used to lose two pairs of twenty-four. The colour and edge
histograms fixed it: it now scores 100%.


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
   | `←` `X` | Not a pair — offers the next best |
   | `S` | Swap before and after |
   | `N` | Neither — no partner at all |
   | `Space` | Skip for now |
   | `P` | Toggle the finished preview |
   | `↑` `↓` | Previous / next car |
   | `Ctrl`+`Z` | Undo |

   When the same angle was shot more than once, a strip of thumbnails under the
   photo shows the other takes with the sharpest already picked — tap another to
   swap it in.

   Whatever is left over drops into **Pair the rest**, below the card. Tap the
   before shot, then tap its after — that order decides which is which, and the
   panel says which step you're on. Tiles are large and every one opens full
   screen, because the photos that end up here are the ones the matcher couldn't
   place, and those are disproportionately interiors that nobody can identify
   from a thumbnail. Anything you leave alone still exports with its car.
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

## Why importing a hundred photos on an iPhone takes so long

Three separate waits, and only two of them are ours.

**The picker's own wait, which is not ours and cannot be made ours.** After you
tap the checkmark, iOS converts every selected photo to JPEG before it hands
anything to the page, showing no progress while it does. The `change` event
doesn't fire until that finishes, so there is no point at which this app could
draw a spinner — it hasn't been given the files yet. The `accept` attribute does
not reliably influence it. What does: in the picker, **Options → Format →
Current** hands over the originals unconverted, and they're about half the size.
The app says so on the import screen, on Apple devices only.

**Reading the files.** Each photo used to be read twice — once to decode and
once for EXIF — strictly one at a time. Invisible when the photos are on the
device, dominant when they aren't: a photo kept in iCloud has to be downloaded
before its bytes can be read, so a 150-photo import was 300 serial round trips
with the CPU idle throughout. Each file is now read once with three reads in
flight, so the decode of one overlaps the download of the next few. `npm run
test:readahead` simulates the latency and measures the overlap: 656ms against
1200ms serial.

**Decoding.** Given the dimensions out of the EXIF header — already parsed, for
the capture time — the decoder can scale during the decode instead of building a
12MP bitmap and immediately shrinking it. Measured on a 12MP frame, 10–23% off
the most expensive step of an import, and more on a phone than on the desktop
those numbers came from.

Only one axis is ever constrained. Passing a single dimension makes the browser
preserve the aspect ratio itself, so if it applies EXIF rotation after the
resize — implementations have differed — the worst case is a proxy larger than
intended rather than a stretched one. `npm run test:decode` checks that, deliberately
including a hint that lies about which way round the photo is.

Decoding stays sequential. Decoding a 12MP photo spikes memory, and doing many
at once is what kills the tab on iOS.

And because a progress bar with a number on it still reads as a hang, photos now
appear in a strip as they land, newest first. It is the difference between
"working" and "stuck", and it costs nothing.

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
npm run test:takes       # three shots of one angle — does the sharpest win?
npm run test:handpair    # pairing the leftovers by hand
npm run test:runnerup    # saying no falls through to the next-best candidate
npm run test:stale       # reopening a session saved by an older build
npm run test:readahead   # import read-ahead, with the file latency simulated
npm run test:decode      # decoding straight to proxy size, and its timing
npm run test:accuracy    # precision/recall across 8 adversarial scenarios
npm run test:diagnose    # distance distributions on synthetic fixtures
npm run test:diagnose:real  # …and on real photos. Run before touching a threshold.
npm run test:diagnose:takes # same-take vs different-angle, on both photo sources
npm run test:diagnose:interior # the whole before x after matrix, per component
npm run test:diagnose:descriptors # scores candidate scoring functions on real photos
npm run test:diagnose:features # ORB keypoint matching, scored against the above
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
src/lib/hash.ts        fingerprinting — colour and edge histograms, luma grids, dHash, shot quality
src/lib/cluster.ts     car grouping on the clock, take collapsing, pair suggestion
src/lib/assign.ts      optimal one-to-one assignment (Hungarian)
src/lib/render.ts      the composite renderer
src/lib/exporter.ts    full-resolution rendering, ZIP and share-sheet packing
src/lib/ingest.ts      read-ahead, decode, downscale, EXIF, fingerprint
src/lib/canvasPool.ts  shared scratch canvases
src/lib/features.ts    ORB keypoints + RANSAC — measured, not currently used
src/lib/db.ts          IndexedDB session persistence, with a schema version
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

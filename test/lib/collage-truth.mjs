/**
 * Ground truth recovered from the user's own exported collages.
 *
 * Every collage is two photos the user personally decided belonged together,
 * so each one is a labelled positive that cost nobody any labelling effort.
 * scripts/split-collages.mjs cuts the panels back out; this file records what
 * they are.
 *
 * The value of the set is not its size. It is that it contains the failure the
 * matcher was reported to have: `kia-wheel` and `kia-rear-seat` are the *same
 * red car*, photographed twice each. A wheel and a back seat, both belonging to
 * one job, are exactly the confusion described as "it kept mashing them with
 * the wheels". Any scoring change that starts pairing across those two subjects
 * has reintroduced the bug, and this set will say so.
 *
 * `grey-rear-seat` is the second trap: a rear bench in a different car with
 * near-identical composition to the Kia's. Two photos can share a subject, a
 * framing and a palette and still be different vehicles.
 */

/** Panel stem → what it shows. Both panels of a stem are one true pair. */
export const SUBJECT = {
  'bmw-exterior': 'dark blue BMW coupe, front three-quarter',
  'ioniq-front-interior': 'Ioniq passenger footwell and dash',
  'kia-wheel': 'red Kia front wheel, close',
  'kia-rear-seat': 'red Kia rear bench, door open',
  'grey-rear-seat': 'grey cloth rear bench',
}

export const STEMS = Object.keys(SUBJECT)

/** Panels that are the same physical vehicle, though not the same shot. */
export const SAME_CAR = [['kia-wheel', 'kia-rear-seat']]

/** Panels whose subject matter looks alike across different vehicles. */
export const LOOKALIKE = [['kia-rear-seat', 'grey-rear-seat']]

/** `bmw-exterior-a` → `bmw-exterior`. */
export const stemOf = (name) => name.replace(/-(a|b)\.jpe?g$/i, '')

/** The one correct partner for a panel. */
export const partnerOf = (name) =>
  name.replace(/-(a|b)(\.jpe?g)$/i, (_, side, ext) => `-${side === 'a' ? 'b' : 'a'}${ext}`)

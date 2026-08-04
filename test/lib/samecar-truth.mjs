/**
 * Ground truth for the one-Jeep fixture set, established by looking at every
 * photograph.
 *
 * It lives here because three suites need it and it has already been wrong
 * once: the two centre-console shots were recorded as "no partner", and they
 * are in fact a before/after pair — the console dusty, then the console wiped.
 * A test asserting they must never be paired was locking in the bug it should
 * have caught. Copies of that mistake in three files would have been three
 * places to miss.
 *
 * The photos carry no EXIF once they have been through an upload, so the
 * sequence number is the only ordering, and it is reliable: the camera counts
 * up. What it shows is a walk around the car one way and back the other.
 *
 *   BEFORE   7986 exterior · 7993 wheel · 7996 trunk · 8001 seat · 8003 console
 *   AFTER                     8005 console · 8006 trunk · 8009 wheel · 8011 exterior
 *
 * The seat has no after in this set, which is the point of keeping it: a real
 * roll has odd photos in it, and the matcher has to leave them alone.
 */

/** In capture order. The before pass, then the job, then the after pass. */
export const BEFORE = ['7986', '7993', '7996', '8001', '8003']
export const AFTER = ['8005', '8006', '8009', '8011']

/** before -> after. */
export const PAIRS = {
  7986: 8011,
  7993: 8009,
  7996: 8006,
  8003: 8005,
}

/** Shot before it, with no partner anywhere in the set. */
export const NO_PARTNER = ['8001']

/** What each frame actually shows, for readable failure output. */
export const SUBJECT = {
  7986: 'exterior, dirty',
  7993: 'wheel, dirty',
  7996: 'trunk, dirty',
  8001: 'seat + footwell, dirty',
  8003: 'console, dirty',
  8005: 'console, clean',
  8006: 'trunk, clean',
  8009: 'wheel, clean',
  8011: 'exterior, clean',
}

/** The three interior frames. Kept separate because they are the hard ones. */
export const INTERIOR = ['8001', '8003', '8005']

export const num = (name) => name?.match(/IMG_(\d+)/)?.[1] ?? null
export const isBefore = (name) => BEFORE.includes(num(name))

/**
 * Capture times for the fixture, in minutes from the start of the job.
 *
 * Every before shot first, then roughly four hours of detailing, then every
 * after shot — which is how the photos are actually taken, and what the
 * grouping has to survive without splitting the car in two.
 */
export const MINUTES = {
  7986: 0,
  7993: 6,
  7996: 13,
  8001: 19,
  8003: 24,
  8005: 264,
  8006: 270,
  8009: 277,
  8011: 284,
}

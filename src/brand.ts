/**
 * What the app is called, in one place.
 *
 * "unbklok" was never a chosen name — it was the name of an empty GitHub repo
 * that happened to be handy on day one, and it stuck by accident all the way
 * through. It appears in the header, the page title, the installed app's name
 * and the exported ZIP's filename, so it was four places to forget.
 *
 * Now it is one. Changing the two constants below renames everything the user
 * ever sees; nothing else needs touching.
 */

/** Shown in the header, the install prompt and the browser tab. */
export const APP_NAME = 'Before & After'

/** The tab title and the installed app's full name. */
export const APP_TAGLINE = 'Detail Photos'

/**
 * Prefix for exported files. Lowercase, no spaces — it becomes a filename on
 * someone's phone, and a name with a space in it is a name that gets mangled
 * somewhere between here and Instagram.
 */
export const FILE_PREFIX = APP_NAME.toLowerCase()
  .replace(/&/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')

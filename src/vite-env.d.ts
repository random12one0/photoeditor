/// <reference types="vite/client" />

/**
 * Injected by vite.config.ts, so a stale cached build is identifiable rather
 * than merely suspected.
 *
 * `__APP_VERSION__` is the short readable one — "1.0.0" — and comes from
 * package.json. `__BUILD_ID__` is the date and commit, for when the version
 * alone isn't specific enough.
 */
declare const __APP_VERSION__: string
declare const __BUILD_ID__: string

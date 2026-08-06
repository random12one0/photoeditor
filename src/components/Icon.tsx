/**
 * Inline icon set.
 *
 * Drawn rather than pulled from a font or an emoji: emoji render differently on
 * every platform and instantly cheapen an interface, and a whole icon font is a
 * lot of bytes for a dozen glyphs. These share one stroke weight and a 24px grid
 * so they sit together properly.
 */

export type IconName =
  | 'upload'
  | 'cars'
  | 'pair'
  | 'sliders'
  | 'share'
  | 'check'
  | 'close'
  | 'swap'
  | 'skip'
  | 'undo'
  | 'eye'
  | 'download'
  | 'trash'
  | 'split'
  | 'merge'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronDown'
  | 'keyboard'
  | 'plus'
  | 'clock'
  | 'copy'
  | 'sparkle'
  | 'flask'
  | 'thumbUp'
  | 'thumbDown'

const PATHS: Record<IconName, JSX.Element> = {
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="m6.5 9.5 5.5-5.5 5.5 5.5" />
      <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" />
    </>
  ),
  cars: (
    <>
      <path d="M4 15.5h16" />
      <path d="M5.5 15.5v2a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-4.2a2 2 0 0 1 .3-1L5 8.4A2 2 0 0 1 6.7 7.5h10.6A2 2 0 0 1 19 8.4l2.2 3.9a2 2 0 0 1 .3 1v4.2a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-2" />
      <path d="M4.5 12h15" />
      <circle cx="7.5" cy="15.5" r=".6" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="15.5" r=".6" fill="currentColor" stroke="none" />
    </>
  ),
  pair: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.6" />
      <rect x="3" y="13" width="18" height="7" rx="1.6" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h10M18 7h2" />
      <path d="M4 12h4M12 12h8" />
      <path d="M4 17h12M20 17h0" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="17" r="2" />
    </>
  ),
  share: (
    <>
      <path d="M12 15V4" />
      <path d="m8 7.5 4-3.5 4 3.5" />
      <path d="M5 13v6.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V13" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  swap: (
    <>
      <path d="M7 4v13" />
      <path d="m3.5 13.5 3.5 3.5 3.5-3.5" />
      <path d="M17 20V7" />
      <path d="m13.5 10.5 3.5-3.5 3.5 3.5" />
    </>
  ),
  skip: (
    <>
      <path d="m5 6 7 6-7 6z" />
      <path d="m13 6 7 6-7 6z" />
    </>
  ),
  undo: (
    <>
      <path d="M4 9h11a4.5 4.5 0 0 1 0 9h-5" />
      <path d="m7.5 5.5-3.5 3.5 3.5 3.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4 18.5h16" />
    </>
  ),
  trash: (
    <>
      <path d="M4 6.5h16" />
      <path d="M9 6.5V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5" />
      <path d="M6 6.5 6.8 19a1.5 1.5 0 0 0 1.5 1.4h7.4a1.5 1.5 0 0 0 1.5-1.4L18 6.5" />
    </>
  ),
  split: (
    <>
      <path d="M12 4v16" strokeDasharray="3 3" />
      <path d="M8 9 4.5 12 8 15" />
      <path d="m16 9 3.5 3-3.5 3" />
    </>
  ),
  merge: (
    <>
      <path d="M4 7h6l4 5 6 0" />
      <path d="M4 17h6l2-2.5" />
      <path d="m17 9 3 3-3 3" />
    </>
  ),
  chevronLeft: <path d="m14.5 5-6 7 6 7" />,
  chevronRight: <path d="m9.5 5 6 7-6 7" />,
  chevronDown: <path d="m5 9.5 7 6 7-6" />,
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 4.5 13.6 9l4.4 1.6-4.4 1.6L12 16.7l-1.6-4.5L6 10.6 10.4 9 12 4.5Z" />
      <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" />
    </>
  ),
  flask: (
    <>
      <path d="M9.5 3.5h5" />
      <path d="M10.5 3.5v6L5.8 17.4A2 2 0 0 0 7.5 20.5h9a2 2 0 0 0 1.7-3.1L13.5 9.5v-6" />
      <path d="M8.2 14.5h7.6" />
    </>
  ),
  thumbUp: (
    <>
      <path d="M7 10.5v9H4.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H7Z" />
      <path d="M7 10.5 11 3.5a2 2 0 0 1 2 2v4h5.2a1.8 1.8 0 0 1 1.75 2.2l-1.4 6A1.8 1.8 0 0 1 16.8 19.5H7" />
    </>
  ),
  thumbDown: (
    <>
      <path d="M7 13.5v-9H4.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1H7Z" />
      <path d="M7 13.5 11 20.5a2 2 0 0 0 2-2v-4h5.2a1.8 1.8 0 0 0 1.75-2.2l-1.4-6A1.8 1.8 0 0 0 16.8 4.5H7" />
    </>
  ),
}

interface Props {
  name: IconName
  size?: number
  className?: string
}

export default function Icon({ name, size = 20, className }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

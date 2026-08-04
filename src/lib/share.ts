/**
 * Sharing finished composites.
 *
 * On a phone a ZIP is close to useless — iOS drops it in Files, and getting the
 * images out and into Instagram is several awkward steps. The Web Share API
 * hands the images straight to the OS share sheet, so the route from "confirm
 * pair" to "posted" is two taps. ZIP stays the right answer on desktop.
 */

export function canShareFiles(files: File[]): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    typeof navigator.share === 'function' &&
    navigator.canShare({ files })
  )
}

/** True when this device can share images at all. Used to pick the UI. */
export function supportsImageShare(): boolean {
  try {
    const probe = new File([new Blob([new Uint8Array([0xff, 0xd8, 0xff])])], 'p.jpg', {
      type: 'image/jpeg',
    })
    return canShareFiles([probe])
  } catch {
    return false
  }
}

export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported'

export async function shareFiles(
  files: File[],
  title: string,
): Promise<ShareOutcome> {
  if (!canShareFiles(files)) return 'unsupported'
  try {
    await navigator.share({ files, title })
    return 'shared'
  } catch (err) {
    // The user dismissing the sheet throws AbortError; that isn't a failure.
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
    throw err
  }
}

export function blobToFile(blob: Blob, name: string): File {
  return new File([blob], name, { type: blob.type || 'image/jpeg' })
}

/**
 * True when the app is running inside someone else's page rather than at its
 * own address.
 *
 * This matters for one reason: a sandboxed iframe blocks downloads unless the
 * embedding page opted in, and the block is silent. Clicking Download does
 * nothing at all — no error, no file, nothing to report — which is exactly how
 * it was described from a phone. Sharing and copying still work, because those
 * go through the OS rather than through a navigation.
 *
 * Detected by the frame check throwing or disagreeing; a cross-origin parent
 * makes `window.top` unreadable, which is itself the answer.
 */
export function isEmbedded(): boolean {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

/** Copy an image to the clipboard, where the platform allows it. */
export async function copyImage(blob: Blob): Promise<boolean> {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') return false
    // Safari only accepts PNG on the clipboard; convert when needed.
    let item = blob
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bmp.width
      canvas.height = bmp.height
      canvas.getContext('2d')!.drawImage(bmp, 0, 0)
      bmp.close()
      item = await new Promise<Blob>((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'),
      )
      canvas.width = 1
      canvas.height = 1
    }
    await navigator.clipboard.write([new ClipboardItem({ [item.type]: item })])
    return true
  } catch {
    return false
  }
}

/** Short buzz on a decisive action. Silently absent on iOS, which is fine. */
export function haptic(pattern: number | number[] = 12): void {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* not supported */
  }
}

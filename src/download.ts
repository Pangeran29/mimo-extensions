// Chrome uses USER_CANCELED for an interrupted download and "Download canceled"
// when dismissing the file picker rejects download() before an ID is returned.
// Keep this allowlist narrow: unknown errors must retain recoverable audio.
export function isDownloadCancelled(reason?: string): boolean {
  return reason === 'USER_CANCELED' || reason === 'Download canceled' || reason === 'Download canceled.';
}

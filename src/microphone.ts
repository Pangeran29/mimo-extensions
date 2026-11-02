/** Verify current permission and hardware without leaving a microphone track open. */
export async function checkMicrophone(): Promise<void> {
  const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
  if (permission.state !== 'granted') throw new Error('Allow microphone access in Settings.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    try {
      if (!stream.getAudioTracks().some((track) => track.readyState === 'live'))
        throw new Error('No working microphone.');
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
  } catch {
    throw new Error('Microphone unavailable. Check the device and permissions in Settings.');
  }
}

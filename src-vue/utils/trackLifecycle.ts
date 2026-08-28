import type { JitsiTrack } from '@/types/jitsi';

function collectVideoTracks(track: JitsiTrack): MediaStreamTrack[] {
  const seen = new Set<MediaStreamTrack>();
  const add = (vt: MediaStreamTrack | undefined | null) => {
    if (vt) seen.add(vt);
  };
  try {
    add(typeof track.getTrack === 'function' ? track.getTrack() : undefined);
  } catch {
    /* track not ready */
  }
  const stream = (track as unknown as { getOriginalStream?: () => MediaStream }).getOriginalStream?.();
  stream?.getVideoTracks?.()?.forEach(add);
  return [...seen];
}

/** Run callback when the underlying camera/desktop MediaStream track ends (browser stop share). */
export function onVideoTrackEnded(track: JitsiTrack, onEnd: () => void): () => void {
  const tracks = collectVideoTracks(track);
  if (!tracks.length) return () => {};
  let done = false;
  const handler = () => {
    if (done) return;
    done = true;
    onEnd();
  };
  for (const vt of tracks) {
    if (vt.readyState === 'ended') {
      handler();
      return () => {};
    }
    vt.addEventListener('ended', handler);
  }
  return () => {
    for (const vt of tracks) vt.removeEventListener('ended', handler);
  };
}

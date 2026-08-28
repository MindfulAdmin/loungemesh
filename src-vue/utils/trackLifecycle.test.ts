import { describe, expect, it, vi } from 'vitest';
import type { JitsiTrack } from '@/types/jitsi';
import { onVideoTrackEnded } from './trackLifecycle';

describe('onVideoTrackEnded', () => {
  it('calls onEnd when the media track ends', () => {
    const listeners: Record<string, () => void> = {};
    const vt = {
      addEventListener: (type: string, fn: () => void) => {
        listeners[type] = fn;
      },
      removeEventListener: vi.fn(),
    };
    const stream = { getVideoTracks: () => [vt] } as unknown as MediaStream;
    const track = {
      getOriginalStream: () => stream,
    } as unknown as JitsiTrack;
    const onEnd = vi.fn();
    const unbind = onVideoTrackEnded(track, onEnd);
    listeners.ended?.();
    expect(onEnd).toHaveBeenCalled();
    unbind();
  });

  it('no-ops when stream is missing', () => {
    const onEnd = vi.fn();
    onVideoTrackEnded({} as JitsiTrack, onEnd);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('calls onEnd when getTrack ends without an original stream', () => {
    const listeners: Record<string, () => void> = {};
    const vt = {
      readyState: 'live',
      addEventListener: (type: string, fn: () => void) => {
        listeners[type] = fn;
      },
      removeEventListener: vi.fn(),
    };
    const track = {
      getTrack: () => vt,
    } as unknown as JitsiTrack;
    const onEnd = vi.fn();
    const unbind = onVideoTrackEnded(track, onEnd);
    listeners.ended?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
    unbind();
  });

  it('fires immediately when the media track is already ended', () => {
    const vt = {
      readyState: 'ended',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const track = {
      getTrack: () => vt,
    } as unknown as JitsiTrack;
    const onEnd = vi.fn();
    onVideoTrackEnded(track, onEnd);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(vt.addEventListener).not.toHaveBeenCalled();
  });

  it('calls onEnd only once when both getTrack and original stream end', () => {
    const listeners: Record<string, () => void> = {};
    const vt = {
      readyState: 'live',
      addEventListener: (_type: string, fn: () => void) => {
        listeners.a = fn;
      },
      removeEventListener: vi.fn(),
    };
    const clone = {
      readyState: 'live',
      addEventListener: (_type: string, fn: () => void) => {
        listeners.b = fn;
      },
      removeEventListener: vi.fn(),
    };
    const track = {
      getTrack: () => vt,
      getOriginalStream: () => ({ getVideoTracks: () => [clone] }),
    } as unknown as JitsiTrack;
    const onEnd = vi.fn();
    onVideoTrackEnded(track, onEnd);
    listeners.a?.();
    listeners.b?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

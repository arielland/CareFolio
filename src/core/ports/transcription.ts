import type { AnyContext } from '@/core/context/space-context';

/**
 * Hebrew speech-to-text for visit recordings (M4).
 *
 * The provider is deliberately undecided — see DESIGN.md §12. This port is the seam
 * that lets a hosted API be swapped for a self-hosted Hebrew-tuned Whisper running in
 * a sidecar, if privacy or accuracy demands it, without touching the visits module.
 */

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
}

export interface Transcript {
  language: string;
  text: string;
  segments: TranscriptSegment[];
  durationMs: number;
}

export interface TranscriptionPort {
  transcribe(
    ctx: AnyContext,
    audio: { data: Uint8Array; mimeType: string },
    opts?: { languageHint?: string },
  ): Promise<Transcript>;
}

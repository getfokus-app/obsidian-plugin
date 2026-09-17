import { FokusApiError } from '@/api/errors';

/**
 * Errors where continuing the queue is pointless, so a run stops on the first
 * one rather than pushing every remaining file into the same refusal.
 *
 * `pro-required` belongs here for a reason the other two do not: it will not
 * resolve by waiting. Without it a first full sync of a few hundred notes
 * produced a Notice per note — a paywall rendered as hundreds of identical
 * popups, which is the worst possible way to tell someone to upgrade.
 *
 * Pure, and in its own module, so it can be tested: `main.ts` imports Obsidian
 * and cannot be loaded by the unit suite at all.
 */
export function isBackoff(error: unknown): boolean {
  return (
    error instanceof FokusApiError &&
    (error.kind === 'rate-limited' || error.kind === 'offline' || error.kind === 'pro-required')
  );
}

import type { AdrSyncState } from '../model/types.ts';

export const ADR_SYNC_LABEL: Record<AdrSyncState, string> = {
  'not-promoted': 'Not promoted',
  'up-to-date': 'Up to date',
  'out-of-date': 'Out of date',
  unfilled: 'Unfilled',
  none: 'None',
  error: 'Error',
};

import { describe, it, expect } from 'vitest';

import { findingGuideUrl } from '../src/docs-site-config.js';

describe('findingGuideUrl', () => {
  it('builds a docs-site guide URL anchored to the lowercase board tag', () => {
    expect(findingGuideUrl('skew')).toBe('docs/user-guide/understanding-findings.html#skew');
    expect(findingGuideUrl('shuffle')).toBe('docs/user-guide/understanding-findings.html#shfl');
  });

  it('maps configAudit to the single CFG anchor regardless of which property triggered it', () => {
    expect(findingGuideUrl('configAudit')).toBe('docs/user-guide/understanding-findings.html#cfg');
  });

  it('maps both broadcast-sizing directions to the same PLAN anchor', () => {
    expect(findingGuideUrl('underBroadcast')).toBe('docs/user-guide/understanding-findings.html#plan');
    expect(findingGuideUrl('overBroadcast')).toBe('docs/user-guide/understanding-findings.html#plan');
  });

  it('falls back to the uppercased type itself for a type with no TYPE_TAG_MAP entry', () => {
    expect(findingGuideUrl('zetaSignal')).toBe('docs/user-guide/understanding-findings.html#zetasignal');
  });
});

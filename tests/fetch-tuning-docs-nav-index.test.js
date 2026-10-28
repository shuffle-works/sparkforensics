import { describe, it, expect } from 'vitest';
import { projectNavIndex } from '../scripts/fetch-tuning-docs.mjs';

const sparkManifest = {
  groups: [
    { title: 'Getting Started', entries: [{ file: 'content/01-intro.md', anchor: 'intro', title: 'Introduction', brief: 'Guide overview.', keywords: ['x'] }] },
    { title: 'Bottleneck Reference', entries: [{ file: 'content/bottlenecks/skew.md', anchor: 'bottleneck-skew', title: 'Data Skew' }] },
  ],
};

describe('projectNavIndex', () => {
  it('projects spark entries with store + slug, preserving order and section', () => {
    expect(projectNavIndex(sparkManifest)).toEqual([
      { anchor: 'intro', section: 'Getting Started', title: 'Introduction', brief: 'Guide overview.', keywords: ['x'], store: 'chapters', slug: '01-intro' },
      { anchor: 'bottleneck-skew', section: 'Bottleneck Reference', title: 'Data Skew', brief: '', keywords: [], store: 'tuning', slug: 'skew' },
    ]);
  });

  it('keeps the subfolder in a chapter slug', () => {
    const manifest = { groups: [{ title: 'Native Engines', entries: [{ file: 'content/native-engines/photon.md', anchor: 'native-photon', title: 'Photon' }] }] };
    expect(projectNavIndex(manifest)[0]).toMatchObject({ store: 'chapters', slug: 'native-engines/photon' });
  });
});

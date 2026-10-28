import type { ComponentProps, ComponentType } from 'react';
import { expect, it } from 'vitest';

import { coldStartContent } from './_shared/evidence-panel';
import { REGISTRY, type RegistryEntryOf, type WidgetProps } from '@/view/detector-registry';
import { allRows, evidencePanel, unstatedRows, type AnyEvidencePanel, type ContentCheck } from '@/view/evidence-panel';
import type { InlineEvidence } from '@/view/InlineEvidence';

// `tsc --noEmit` is the test: each `@ts-expect-error` below fails the typecheck when the line stops
// being an error, so each wrong design stays a compile error.

const Widget: ComponentType<WidgetProps> = () => null;
const overBroadcast = { component: Widget, region: 'action', widgetId: 'over-broadcast', routeable: true } as const;
type PanelProp = ComponentProps<typeof InlineEvidence>['panel'];

it('requires every registry entry to say what its panel shows', () => {
  // @ts-expect-error -- an entry without `content`
  const missing: RegistryEntryOf<'overBroadcast'> = { ...overBroadcast };
  // @ts-expect-error -- a check written for another finding type
  const wrongType: RegistryEntryOf<'overBroadcast'> = { ...overBroadcast, content: coldStartContent };
  const right: RegistryEntryOf<'overBroadcast'> = { ...overBroadcast, content: unstatedRows };
  const everyRow: RegistryEntryOf<'overBroadcast'> = { ...overBroadcast, content: allRows };
  expect([missing, wrongType, right, everyRow]).toHaveLength(4);
  // Every registered type has a check at runtime too.
  expect(Object.values(REGISTRY).every((entry) => typeof entry.content === 'function')).toBe(true);
});

it('gives the evidence panel only to a value the content check made', () => {
  const noPanel: AnyEvidencePanel | null = null as AnyEvidencePanel | null;
  // @ts-expect-error -- a panel that may be null: the host must branch on it first
  const maybe: PanelProp = noPanel;
  // @ts-expect-error -- a hand-built object is not a panel
  const forged: PanelProp = { type: 'overBroadcast', rows: [] };
  const check: ContentCheck<'coldStart'> = coldStartContent;
  const made = evidencePanel('coldStart', check, { findings: [], stated: new Set(), density: 'basic', appModel: undefined as never });
  expect([maybe, forged, made]).toHaveLength(3);
  // No rows, no panel.
  expect(made).toBeNull();
});

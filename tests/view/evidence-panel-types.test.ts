import type { ComponentProps, ComponentType } from 'react';
import { expect, it } from 'vitest';

import { coldStartRows } from './_shared/evidence-panel';
import { REGISTRY, type RegistryEntryOf, type WidgetProps } from '@/view/detector-registry';
import { evidencePanel, type AnyEvidencePanel } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import type { InlineEvidence } from '@/view/InlineEvidence';
import { coldStartModel } from '@/view/widgets/ColdStart.rows';
import { overBroadcastModel } from '@/view/widgets/OverBroadcast.rows';

// `tsc --noEmit` is the test: each `@ts-expect-error` below fails the typecheck when the line stops
// being an error, so each wrong design stays a compile error.

const Widget: ComponentType<WidgetProps> = () => null;
const overBroadcast = { component: Widget, region: 'action', widgetId: 'over-broadcast', routeable: true } as const;
type PanelProp = ComponentProps<typeof InlineEvidence>['panel'];

it('requires every registry entry to say what its widget shows', () => {
  // @ts-expect-error -- an entry without a model
  const missing: RegistryEntryOf<'overBroadcast'> = { ...overBroadcast };
  // @ts-expect-error -- a model written for another finding type
  const wrongType: RegistryEntryOf<'overBroadcast'> = { ...overBroadcast, model: coldStartModel };
  const right: RegistryEntryOf<'overBroadcast'> = { ...overBroadcast, model: overBroadcastModel };
  expect([missing, wrongType, right]).toHaveLength(3);
  // Every registered type has a model at runtime too.
  expect(Object.values(REGISTRY).every((entry) => typeof entry.model.rows === 'function')).toBe(true);
});

it('gives the evidence panel only to a value the rows made', () => {
  const noPanel: AnyEvidencePanel | null = null as AnyEvidencePanel | null;
  // @ts-expect-error -- a panel that may be null: the host must branch on it first
  const maybe: PanelProp = noPanel;
  // @ts-expect-error -- a hand-built object is not a panel
  const forged: PanelProp = { type: 'overBroadcast', rows: [] };
  const made = evidencePanel('coldStart', coldStartRows, { findings: [], stated: new Set(), density: 'basic', appModel: undefined as never });
  expect([maybe, forged, made]).toHaveLength(3);
  // No rows, no panel.
  expect(made).toBeNull();
});

it('keeps a model tied to its own finding type', () => {
  // @ts-expect-error -- rows of one type under another type's model
  const crossed: FindingWidgetModel<'coldStart', never> = overBroadcastModel;
  expect(crossed).toBeDefined();
});

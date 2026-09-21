// Shared assertion for the "impact order by default, Stage button flips to
// declaration order" behavior duplicated (with only label text varying)
// across every widget that carries a wall-clock sort toggle.
import { expect } from 'vitest';
import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

// For widgets whose rows are elements with an accessible name (e.g. buttons
// whose visible text is abbreviated but carry a fuller aria-label).
export async function expectImpactThenStageOrderByAccessibleName(
  user: UserEvent,
  getOrderedElements: () => HTMLElement[],
  lowLabel: string | RegExp,
  highLabel: string | RegExp,
) {
  let els = getOrderedElements();
  expect(els[0]).toHaveAccessibleName(highLabel);
  expect(els[1]).toHaveAccessibleName(lowLabel);

  await user.click(screen.getByRole('button', { name: 'Stage' }));

  els = getOrderedElements();
  expect(els[0]).toHaveAccessibleName(lowLabel);
  expect(els[1]).toHaveAccessibleName(highLabel);
}

// For widgets whose rows are compared as a whole array (aria-label list or
// text-content list) via toEqual rather than per-element matchers.
export async function expectImpactThenStageOrderByArray(
  user: UserEvent,
  getOrderedLabels: () => Array<string | null>,
  lowLabel: string,
  highLabel: string,
) {
  expect(getOrderedLabels()).toEqual([highLabel, lowLabel]);

  await user.click(screen.getByRole('button', { name: 'Stage' }));

  expect(getOrderedLabels()).toEqual([lowLabel, highLabel]);
}

// For widgets whose rows are plain elements (e.g. <li>) where textContent is
// the visible, matchable label.
export async function expectImpactThenStageOrderByText(
  user: UserEvent,
  getOrderedLabels: () => string[],
  lowLabel: string | RegExp,
  highLabel: string | RegExp,
) {
  let labels = getOrderedLabels();
  expect(labels[0]).toMatch(highLabel);
  expect(labels[1]).toMatch(lowLabel);

  await user.click(screen.getByRole('button', { name: 'Stage' }));

  labels = getOrderedLabels();
  expect(labels[0]).toMatch(lowLabel);
  expect(labels[1]).toMatch(highLabel);
}

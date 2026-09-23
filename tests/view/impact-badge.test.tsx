// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TagBadge, ImpactDot, Chip } from '../../src/view/ImpactBadge';
import { store } from '../../src/store/store';

test('renders ALL-CAPS tag with no emoji', () => {
  render(<TagBadge type="spill" impactBand="critical" />);
  const el = screen.getByText('SPILL');
  expect(el).toBeInTheDocument();
  expect(el.textContent).toMatch(/^[A-Z]+$/); // caps only, no emoji
});
test('configAudit maps to CFG', () => {
  render(<TagBadge type="configAudit" impactBand="warning" />);
  expect(screen.getByText('CFG')).toBeInTheDocument();
});

test('ImpactDot renders an impact-colored dot with no text', () => {
  const { container } = render(<ImpactDot impactBand="critical" />);
  const dot = container.firstElementChild;
  expect(dot).toBeInTheDocument();
  expect(dot?.textContent).toBe('');
  expect(dot?.className).toMatch(/critical/);
});

test('Chip renders a mono-styled label with a title tooltip', () => {
  render(<Chip label="skew spill" impactBand="info" title="Skew spill: rebalance partitioning" />);
  const el = screen.getByText('skew spill');
  expect(el).toBeInTheDocument();
  expect(el).toHaveAttribute('title', 'Skew spill: rebalance partitioning');
  expect(el.className).toMatch(/font-mono/);
});

test('renders a SparkForensics guide link alongside the badge at Advanced density, anchored to the tag\'s understanding-findings.md entry', () => {
  store.getState().setWidgetDensity('advanced');
  render(<TagBadge type="skew" impactBand="warning" />);
  const guideLink = screen.getByRole('link', { name: /sparkforensics guide: task skew/i });
  expect(guideLink).toHaveAttribute('href', 'docs/user-guide/understanding-findings.html#skew');
  expect(guideLink).toHaveAttribute('target', '_blank');
  expect(guideLink).toHaveAttribute('rel', 'noopener noreferrer');
  store.getState().setWidgetDensity('basic');
});

test('hides the guide link at Basic density, keeping the dot+tag pill', () => {
  render(<TagBadge type="skew" impactBand="warning" />);
  expect(screen.queryByRole('link', { name: /sparkforensics guide/i })).not.toBeInTheDocument();
  expect(screen.getByText('SKEW')).toBeInTheDocument();
});

test('a type with no vendor-doc anchor (incompleteRun) still renders its pill as a real link, to the SparkForensics guide instead', () => {
  render(<TagBadge type="incompleteRun" impactBand="warning" />);
  const link = screen.getByRole('link', { name: 'INCMP' });
  expect(link).toHaveAttribute('href', 'docs/user-guide/understanding-findings.html#incmp');
  // No vendor anchor to show a second, redundant guide link for, even at Advanced density.
  store.getState().setWidgetDensity('advanced');
  expect(screen.queryByRole('link', { name: /sparkforensics guide/i })).not.toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('plainBadge suppresses both the vendor-doc link and the guide link', () => {
  // 'skew' has a real vendor-doc anchor, so this proves plainBadge suppresses the link, not that none existed.
  render(<TagBadge type="skew" impactBand="warning" plainBadge />);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

test('a finding-level docAnchor wins over the type lookup, so a configAudit pill links its own sub-check', () => {
  // docAnchorForType('configAudit') is undefined (its four sub-checks disagree), so without the
  // prop the pill falls back to the guide entry.
  render(<TagBadge type="configAudit" impactBand="warning" docAnchor="#config-serializer" />);
  expect(screen.getByRole('link', { name: 'CFG' })).toHaveAttribute('href', 'docs/tuning-reference/config.html#config-serializer');
});

test('an unknown docAnchor falls back to the type-level anchor rather than rendering a dead link', () => {
  render(<TagBadge type="skew" impactBand="warning" docAnchor="#not-a-real-section" />);
  expect(screen.getByRole('link', { name: 'SKEW' })).toHaveAttribute('href', 'docs/tuning-reference/bottleneck-skew.html#bottleneck-skew');
});

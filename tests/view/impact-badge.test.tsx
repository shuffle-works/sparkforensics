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

test('plainBadge suppresses both the vendor-doc link and the guide link', () => {
  // 'skew' has a real vendor-doc anchor, so this proves plainBadge suppresses the link, not that none existed.
  render(<TagBadge type="skew" impactBand="warning" plainBadge />);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

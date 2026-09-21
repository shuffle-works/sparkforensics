// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Section } from '../../src/view/Section';

describe('Section', () => {
  it('lets long values wrap instead of overflowing a narrow container', () => {
    // Regression: grid needs min-w-0 and the value cell must break long
    // strings, else a deep join chain's long key/path clips the Stage Detail modal.
    const longValue = 'a'.repeat(200);
    render(<Section rows={[['Path', longValue]]} />);

    const grid = screen.getByText('Path').parentElement;
    expect(grid?.className).toContain('min-w-0');

    const valueCell = screen.getByText(longValue);
    expect(valueCell.className).toContain('break-words');
  });
});

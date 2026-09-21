// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { Button } from '../../src/components/ui/button';

test('shadcn button renders as an accessible button', () => {
  render(<Button>Load new</Button>);
  expect(screen.getByRole('button', { name: 'Load new' })).toBeInTheDocument();
});

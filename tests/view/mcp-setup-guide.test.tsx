// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpSetupGuide } from '@/view/McpSetupGuide';

test('renders collapsed by default: snippet not visible', () => {
  render(<McpSetupGuide />);
  expect(screen.getByRole('button', { name: /use with an ai assistant \(mcp\)/i })).toBeInTheDocument();
  expect(screen.queryByText(/sparkforensics-mcp/)).not.toBeInTheDocument();
});

test('makes the MCP disclosure trigger comfortable to tap', () => {
  render(<McpSetupGuide />);
  expect(screen.getByRole('button', { name: /use with an ai assistant \(mcp\)/i })).toHaveClass('tap-target-comfortable');
});

test('styles the MCP disclosure trigger like the outlined compare action', () => {
  render(<McpSetupGuide />);
  const trigger = screen.getByRole('button', { name: /use with an ai assistant \(mcp\)/i });
  expect(trigger).toHaveClass('border-border', 'bg-background');
  expect(trigger).not.toHaveClass('border-transparent');
});

test('expands and shows the config snippet on trigger click', async () => {
  const user = userEvent.setup();
  render(<McpSetupGuide />);
  await user.click(screen.getByRole('button', { name: /use with an ai assistant \(mcp\)/i }));
  expect(screen.getByText(/npx sparkforensics-mcp/)).toBeInTheDocument();
});

test('snippet contains the npx install command', async () => {
  const user = userEvent.setup();
  render(<McpSetupGuide />);
  await user.click(screen.getByRole('button', { name: /use with an ai assistant \(mcp\)/i }));
  const snippet = screen.getByTestId('mcp-config-snippet');
  expect(snippet.textContent).toContain('npx sparkforensics-mcp');
});

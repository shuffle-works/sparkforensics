import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadExportPayload } from '@/export/hydrate-store';
import { store } from '@/store/store';
import { ErrorBoundary } from '@/view/ErrorBoundary';
import { DocsWidgetApp } from './DocsWidgetApp';
import { followHostTheme, hostTheme, reportHeight } from './host';
import '../index.css';

/** Where the docs build writes one example's finding id and run payload, next to this app. */
async function loadExample(type: string): Promise<string> {
  const response = await fetch(`../data/${encodeURIComponent(type)}.json`);
  if (!response.ok) throw new Error(`the example data answered ${response.status}`);
  const { findingId, payload } = await response.json();
  const problem = loadExportPayload(payload);
  if (problem != null) throw new Error(problem);
  return findingId;
}

const failure = (error: Error) => <p role="alert" className="p-4 text-sm">This example could not be shown: {error.message}</p>;

const root = document.getElementById('root')!;
const initialTheme = hostTheme();
if (initialTheme) store.getState().setTheme(initialTheme);
followHostTheme((theme) => store.getState().setTheme(theme));

const view = await loadExample(new URLSearchParams(window.location.search).get('type') ?? '').then(
  (findingId) => <DocsWidgetApp findingId={findingId} />,
  failure,
);
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary fallback={failure}>{view}</ErrorBoundary>
  </StrictMode>,
);
reportHeight(root);

import { defineConfig } from 'vitepress';
import footnote from 'markdown-it-footnote';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Root-relative default so a standalone clone works with no config; a hub
// embedding this under a fixed prefix sets DOCS_BASE at build time.
const DOCS_BASE = process.env.DOCS_BASE ?? '/docs/';

// The HTML export (opened via `file://`) has no origin for VitePress's
// client-side router to resolve an absolute base against, and that router
// bakes `base` into a shared framework chunk used for every page's dynamic
// imports (search, page transitions) regardless of that page's own folder
// depth — no single relative value can be correct for every page. MPA mode
// removes the client router entirely (each page becomes a real static page,
// internal links are ordinary full-page loads), which sidesteps that. The
// server-hosted build has no such problem, so it keeps SPA transitions and
// working local search by leaving this off. `vite.export.config.ts`'s
// `docs:build` step is the only caller that sets DOCS_MPA=1; the remaining
// `/docs/`-prefixed paths VitePress still bakes into every page get rewritten
// to the correct relative depth by copy-docs-site.ts, export-only.
const DOCS_MPA = process.env.DOCS_MPA === '1';

// Builds a VitePress sidebar section list from a corpus's nav-index.json,
// grouping entries by their `section` field in file order.
function navSidebar(navIndexUrl: string, base: string) {
  const nav = JSON.parse(readFileSync(fileURLToPath(navIndexUrl), 'utf8')) as
    Array<{ anchor: string; section: string; title: string }>;
  const bySection = new Map<string, { text: string; link: string }[]>();
  for (const e of nav) {
    if (!bySection.has(e.section)) bySection.set(e.section, []);
    bySection.get(e.section)!.push({ text: e.title, link: `${base}${e.anchor}` });
  }
  return [...bySection].map(([text, items]) => ({ text, items }));
}

const tuningSidebar = navSidebar(
  new URL('../../packages/core/src/docs-content/chapters/nav-index.json', import.meta.url).href,
  '/tuning-reference/',
);

export default defineConfig({
  title: 'SparkForensics',
  description: 'Docs for using and contributing to SparkForensics',
  base: DOCS_BASE,
  mpa: DOCS_MPA,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${DOCS_BASE}favicon.svg` }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Recursive:wght,CASL@400..700,0..1&family=JetBrains+Mono:wght@400;500;600&display=swap',
      },
    ],
  ],
  markdown: {
    config(md) { md.use(footnote); },
  },
  themeConfig: {
    logo: '/favicon.svg',
    nav: [
      { text: 'User Guide', link: '/user-guide/getting-started' },
      { text: 'Contributor Guide', link: '/contributor-guide/development-setup' },
      { text: 'Tuning Reference', link: '/tuning-reference/' },
    ],
    sidebar: {
      '/tuning-reference/': tuningSidebar,
      '/user-guide/': [
        {
          text: 'User Guide',
          items: [
            { text: 'Getting started', link: '/user-guide/getting-started' },
            { text: 'Understanding findings', link: '/user-guide/understanding-findings' },
            { text: 'Run comparison mode', link: '/user-guide/run-comparison' },
            { text: 'MCP tools reference', link: '/user-guide/mcp-tools' },
            { text: 'Alternative log retrieval', link: '/user-guide/alternative-log-retrieval' },
          ],
        },
      ],
      '/contributor-guide/': [
        {
          text: 'Contributor Guide',
          items: [
            { text: 'Development setup', link: '/contributor-guide/development-setup' },
            {
              text: 'Architecture',
              link: '/contributor-guide/architecture/',
              collapsed: true,
              items: [
                { text: 'Overview', link: '/contributor-guide/architecture/overview' },
                { text: 'Worker protocol', link: '/contributor-guide/architecture/worker-protocol' },
                { text: 'State & history intake', link: '/contributor-guide/architecture/state-and-history' },
                { text: 'Detector contract', link: '/contributor-guide/architecture/detector-contract' },
                { text: 'Impact estimation', link: '/contributor-guide/architecture/impact-estimation' },
                { text: 'Widget rendering', link: '/contributor-guide/architecture/widget-rendering' },
                { text: 'Board widgets', link: '/contributor-guide/architecture/board-widgets' },
                { text: 'Drill-down', link: '/contributor-guide/architecture/drill-down' },
              ],
            },
            { text: 'Testing & verification', link: '/contributor-guide/testing' },
            { text: 'Contributing', link: '/contributor-guide/contributing' },
          ],
        },
      ],
    },
    search: { provider: 'local' },
  },
});

import { defineConfig } from 'vitepress';
import footnote from 'markdown-it-footnote';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Root-relative default so a standalone clone works with no config; a hub
// embedding this under a fixed prefix sets DOCS_BASE at build time.
const DOCS_BASE = process.env.DOCS_BASE ?? '/docs/';

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

// Measures the pinned top chrome into --sf-anchor-offset; see the file itself.
const anchorOffsetScript = readFileSync(fileURLToPath(new URL('./anchor-offset.js', import.meta.url)), 'utf8');

const tuningSidebar = navSidebar(
  new URL('../../packages/core/src/docs-content/chapters/nav-index.json', import.meta.url).href,
  '/tuning-reference/',
);

export default defineConfig({
  title: 'SparkForensics',
  description: 'Docs for using and contributing to SparkForensics',
  base: DOCS_BASE,
  // In-page links VitePress intercepts land below the probe that
  // anchor-offset.js sizes to the measured chrome (its gap included).
  scrollOffset: { selector: '[data-sf-anchor-offset]', padding: 0 },
  head: [
    ['script', {}, anchorOffsetScript],
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
            { text: 'Finding your event log', link: '/user-guide/alternative-log-retrieval' },
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

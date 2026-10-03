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
            {
              text: 'Getting started',
              link: '/user-guide/getting-started',
              collapsed: true,
              items: [
                { text: 'Reading the dashboard', link: '/user-guide/getting-started/reading-the-dashboard' },
                { text: 'CI and automation', link: '/user-guide/getting-started/ci-and-automation' },
                { text: 'Tuning detector thresholds', link: '/user-guide/getting-started/tuning-thresholds' },
                { text: 'Regression metric keys', link: '/user-guide/getting-started/regression-metric-keys' },
              ],
            },
            { text: 'Understanding findings', link: '/user-guide/understanding-findings' },
            {
              text: 'Run comparison mode',
              link: '/user-guide/run-comparison',
              collapsed: true,
              items: [
                { text: 'How stages are matched', link: '/user-guide/run-comparison/how-stages-are-matched' },
              ],
            },
            {
              text: 'MCP tools reference',
              link: '/user-guide/mcp-tools',
              collapsed: true,
              items: [
                { text: 'diagnose_run', link: '/user-guide/mcp-tools/diagnose-run' },
                { text: 'get_run_summary', link: '/user-guide/mcp-tools/get-run-summary' },
                { text: 'evaluate_budgets', link: '/user-guide/mcp-tools/evaluate-budgets' },
                { text: 'compare_runs', link: '/user-guide/mcp-tools/compare-runs' },
                { text: 'get_finding_evidence', link: '/user-guide/mcp-tools/get-finding-evidence' },
                { text: 'get_finding_documentation', link: '/user-guide/mcp-tools/get-finding-documentation' },
                { text: 'get_reference_doc', link: '/user-guide/mcp-tools/get-reference-doc' },
                { text: 'list_runs', link: '/user-guide/mcp-tools/list-runs' },
              ],
            },
            {
              text: 'Finding your event log',
              link: '/user-guide/alternative-log-retrieval',
              collapsed: true,
              items: [
                { text: 'Managed platforms', link: '/user-guide/alternative-log-retrieval/managed-platforms' },
                { text: 'Behind an SSH bastion', link: '/user-guide/alternative-log-retrieval/ssh-bastion' },
              ],
            },
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
                {
                  text: 'Worker protocol',
                  link: '/contributor-guide/architecture/worker-protocol',
                  collapsed: true,
                  items: [
                    { text: 'Evidence availability', link: '/contributor-guide/architecture/worker-protocol/evidence-availability' },
                    { text: 'Evidence report and finding identity', link: '/contributor-guide/architecture/worker-protocol/evidence-report' },
                    { text: 'CLI and MCP server', link: '/contributor-guide/architecture/worker-protocol/cli-and-mcp' },
                    { text: 'Core and event validation', link: '/contributor-guide/architecture/worker-protocol/core-and-event-validation' },
                  ],
                },
                {
                  text: 'State & history intake',
                  link: '/contributor-guide/architecture/state-and-history',
                  collapsed: true,
                  items: [
                    { text: 'Run comparison internals', link: '/contributor-guide/architecture/state-and-history/run-comparison-internals' },
                    { text: 'History Server intake', link: '/contributor-guide/architecture/state-and-history/history-server-intake' },
                  ],
                },
                {
                  text: 'Detector contract',
                  link: '/contributor-guide/architecture/detector-contract',
                  collapsed: true,
                  items: [
                    { text: 'Plan attribution', link: '/contributor-guide/architecture/detector-contract/plan-attribution' },
                    { text: 'Threshold tables', link: '/contributor-guide/architecture/detector-contract/threshold-tables' },
                  ],
                },
                {
                  text: 'Impact estimation',
                  link: '/contributor-guide/architecture/impact-estimation',
                  collapsed: true,
                  items: [
                    { text: 'Stage union rollup', link: '/contributor-guide/architecture/impact-estimation/stage-union-rollup' },
                    { text: 'Caveats, tuning and coverage', link: '/contributor-guide/architecture/impact-estimation/caveats-tuning-and-coverage' },
                  ],
                },
                {
                  text: 'Widget rendering',
                  link: '/contributor-guide/architecture/widget-rendering',
                  collapsed: true,
                  items: [
                    { text: 'Findings tab', link: '/contributor-guide/architecture/widget-rendering/findings-tab' },
                    { text: 'List sort mode', link: '/contributor-guide/architecture/widget-rendering/list-sort-mode' },
                    { text: 'Row/expand contract', link: '/contributor-guide/architecture/widget-rendering/row-expand-contract' },
                    { text: 'ReferenceSection', link: '/contributor-guide/architecture/widget-rendering/reference-section' },
                    { text: 'Investigation routing', link: '/contributor-guide/architecture/widget-rendering/investigation-routing' },
                  ],
                },
                { text: 'Board widgets', link: '/contributor-guide/architecture/board-widgets' },
                {
                  text: 'Drill-down',
                  link: '/contributor-guide/architecture/drill-down',
                  collapsed: true,
                  items: [
                    { text: 'Plan graph', link: '/contributor-guide/architecture/drill-down/plan-graph' },
                  ],
                },
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

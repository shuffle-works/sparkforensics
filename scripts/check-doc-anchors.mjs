import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Validates every link into the docs site: links between docs-site pages, and
// links from the repo's root docs (AGENTS.md, README.md, CONTRIBUTING.md).
// `vitepress build` flags a link to a missing page but not a link to a heading
// that no longer exists, which is what moving a section breaks. Generated
// tuning-reference pages are not committed, so links into them are skipped.

const ROOT_DOCS = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md'];
const PUBLISHED = /^https:\/\/shuffle-works\.github\.io\/sparkforensics\/docs\/([^#\s]*?)(?:\.html)?(#[^\s]*)?$/;
const BLOB = /^https:\/\/github\.com\/shuffle-works\/sparkforensics\/blob\/[^/]+\/(docs-site\/[^#\s]+\.md)(#[^\s]*)?$/;

// Same slug rules as VitePress's markdown-it-anchor (vitepress/dist/node).
export function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\p{Cc}/gu, '')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase();
}

// Anchors a markdown file defines: explicit `{#id}` or the slug of each ATX
// heading, ignoring fenced code.
export function anchorsOf(markdown) {
  const anchors = new Set();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const m = !fenced && line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (!m) continue;
    const explicit = m[1].match(/\s\{#([^}]+)\}$/);
    if (explicit) {
      anchors.add(explicit[1]);
      continue;
    }
    const text = m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '');
    anchors.add(slugify(text));
  }
  return anchors;
}

function listMarkdown(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.vitepress' || name === 'tuning-reference') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listMarkdown(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

function linksIn(markdown) {
  const links = [];
  let fenced = false;
  markdown.split('\n').forEach((line, i) => {
    if (line.startsWith('```')) fenced = !fenced;
    if (fenced) return;
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) links.push({ url: m[1], line: i + 1 });
  });
  return links;
}

// Returns a list of "file:line: problem" strings; empty when every link holds.
export function checkDocAnchors(root) {
  const docsSite = join(root, 'docs-site');
  const cache = new Map();
  const anchorsFor = (file) => {
    if (!cache.has(file)) cache.set(file, anchorsOf(readFileSync(file, 'utf8')));
    return cache.get(file);
  };
  const problems = [];

  const check = (from, line, targetFile, fragment) => {
    if (!existsSync(targetFile)) {
      problems.push(`${relative(root, from)}:${line}: no such page ${relative(root, targetFile)}`);
    } else if (fragment && !anchorsFor(targetFile).has(fragment)) {
      problems.push(`${relative(root, from)}:${line}: no heading #${fragment} in ${relative(root, targetFile)}`);
    }
  };

  const sources = [...listMarkdown(docsSite), ...ROOT_DOCS.map((f) => join(root, f)).filter(existsSync)];
  for (const file of sources) {
    const inDocs = file.startsWith(docsSite);
    for (const { url, line } of linksIn(readFileSync(file, 'utf8'))) {
      if (/^mailto:/.test(url)) continue;
      const published = url.match(PUBLISHED);
      const blob = url.match(BLOB);
      if (published || blob) {
        const fragment = ((published ? published[2] : blob[2]) ?? '').slice(1);
        if (published) {
          const page = published[1].replace(/\/$/, '');
          if (page.startsWith('tuning-reference')) continue;
          check(file, line, join(docsSite, page === '' ? 'index' : page) + '.md', fragment);
        } else {
          check(file, line, join(root, blob[1]), fragment);
        }
        continue;
      }
      if (/^[a-z]+:/.test(url) || url.startsWith('/')) continue;
      const [path, fragment = ''] = url.split('#');
      const target = path === '' ? file : resolve(dirname(file), path);
      // Root docs only matter when the link points into the docs site.
      if (!inDocs && !target.startsWith(docsSite)) continue;
      if (!target.endsWith('.md')) continue;
      if (target.includes(`${docsSite}/tuning-reference`)) continue;
      check(file, line, target, fragment);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = checkDocAnchors(root);
  if (problems.length) {
    console.error(`Broken doc links:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('Doc anchors OK');
}

import { typeTag } from './format-utils.ts';

// Single source for docs-site (VitePress) links, kept separate from docs-config.ts's vendor
// docs-panel surface so the two doc systems don't blur.
//
// The `.html` extension matters: it's what makes this link resolve in the packaged server/ deploy
// mode, whose static file server matches a request path to a file exactly (no extension guessing).
// VitePress names each page <slug>.html, so the extension-less form would 404 there.
//
// No allowlist needed (unlike isKnownDocAnchor): docs-site-tag-coverage.test.js fails CI if any
// TYPE_TAG_MAP value lacks a documented {#tag} heading.
//
// Relative, not /docs/: keeps working under any subpath the app is published at.
export function findingGuideUrl(type: string): string {
  return `docs/user-guide/understanding-findings.html#${typeTag(type).toLowerCase()}`;
}

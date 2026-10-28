// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { showsEvidence } from './_shared/evidence-panel';

/** A flat evidence panel as the widget card renders it: a title row and the body. */
function panel(body: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = `<section><div><h3>Title</h3></div><div>${body}</div></section>`;
  return container;
}

describe('showsEvidence', () => {
  it('counts visible text, a chart and a table as evidence', () => {
    expect(showsEvidence(panel('<p>Write: 12 MB</p>'))).toBe(true);
    expect(showsEvidence(panel('<svg role="img"></svg>'))).toBe(true);
    expect(showsEvidence(panel('<table></table>'))).toBe(true);
  });

  it('counts an empty body and a decorative icon as no evidence', () => {
    expect(showsEvidence(panel(''))).toBe(false);
    expect(showsEvidence(panel('<span> </span><svg aria-hidden="true"></svg>'))).toBe(false);
  });

  it('counts hidden output as not shown', () => {
    expect(showsEvidence(panel('<p hidden>Write: 12 MB</p>'))).toBe(false);
    expect(showsEvidence(panel('<div hidden><p>Write: 12 MB</p></div>'))).toBe(false);
    expect(showsEvidence(panel('<p style="display: none">Write: 12 MB</p>'))).toBe(false);
    expect(showsEvidence(panel('<p style="visibility: hidden">Write: 12 MB</p>'))).toBe(false);
    expect(showsEvidence(panel('<p class="hidden">Write: 12 MB</p>'))).toBe(false);
    expect(showsEvidence(panel('<div style="display: none"><table></table></div>'))).toBe(false);
  });

  it('counts a hidden body as not shown, and still finds visible evidence beside hidden output', () => {
    const hiddenBody = panel('<p>Write: 12 MB</p>');
    hiddenBody.querySelector('section > div:last-child')!.setAttribute('hidden', '');
    expect(showsEvidence(hiddenBody)).toBe(false);
    expect(showsEvidence(panel('<p hidden>Hidden</p><p>Shown</p>'))).toBe(true);
  });
});

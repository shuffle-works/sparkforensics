// Turns footnote markers ([1], [2], ...) on tuning-reference pages into
// hoverable/focusable/clickable "citation chips": a popover shows the
// citation's title and link, read live from the page's own
// `<section class="footnotes">` list (built by markdown-it-footnote). No new
// data source: this is a pure rendering pass over DOM VitePress already
// produced, applied on every page since not every page carries footnotes.

interface FootnoteEntry {
  href: string | null;
  title: string;
}

const CHIP_CLASS = 'citation-chip';
const POPOVER_ID = 'citation-popover';
const CLOSE_DELAY_MS = 150;

let popoverEl: HTMLElement | null = null;
let currentChip: HTMLAnchorElement | null = null;
let pinned = false;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let globalListenersBound = false;

// Reads each footnote's title/href straight from the rendered footnotes
// list, stripping the backref arrows markdown-it-footnote appends. Three
// real citations in tuning-reference content (book references) have no
// `href`, only a title, so `href` is nullable here by design rather than
// crashing or mislabeling those.
function buildFootnoteMap(): Map<string, FootnoteEntry> {
  const map = new Map<string, FootnoteEntry>();
  document.querySelectorAll<HTMLLIElement>('section.footnotes li.footnote-item[id]').forEach((item) => {
    const clone = item.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('a.footnote-backref').forEach((backref) => backref.remove());
    const link = clone.querySelector<HTMLAnchorElement>('a[href]');
    map.set(item.id, {
      href: link ? link.getAttribute('href') : null,
      title: (clone.textContent ?? '').trim(),
    });
  });
  return map;
}

function cancelClose() {
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function scheduleClose() {
  cancelClose();
  closeTimer = setTimeout(() => {
    if (!pinned) close();
  }, CLOSE_DELAY_MS);
}

function close() {
  cancelClose();
  popoverEl?.remove();
  popoverEl = null;
  currentChip?.removeAttribute('aria-describedby');
  currentChip?.setAttribute('aria-expanded', 'false');
  currentChip = null;
  pinned = false;
}

function positionPopover(popover: HTMLElement, chip: HTMLElement) {
  const chipRect = chip.getBoundingClientRect();
  const margin = 6;
  const { width, height } = popover.getBoundingClientRect();
  let top = chipRect.bottom + margin;
  if (top + height > window.innerHeight - 8) {
    top = chipRect.top - height - margin;
  }
  const maxLeft = window.innerWidth - width - 8;
  popover.style.top = `${Math.max(8, top)}px`;
  popover.style.left = `${Math.min(Math.max(8, chipRect.left), Math.max(8, maxLeft))}px`;
}

function open(chip: HTMLAnchorElement, entry: FootnoteEntry, pin: boolean) {
  cancelClose();
  const reusingChip = currentChip === chip;
  if (!reusingChip) currentChip?.setAttribute('aria-expanded', 'false');

  if (!popoverEl) {
    popoverEl = document.createElement('div');
    popoverEl.id = POPOVER_ID;
    popoverEl.className = 'citation-popover';
    popoverEl.setAttribute('role', 'tooltip');
    popoverEl.addEventListener('mouseenter', cancelClose);
    popoverEl.addEventListener('mouseleave', scheduleClose);
    document.body.appendChild(popoverEl);
  }

  popoverEl.replaceChildren();
  if (entry.href) {
    const link = document.createElement('a');
    link.href = entry.href;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = entry.title;
    popoverEl.appendChild(link);
  } else {
    popoverEl.textContent = entry.title;
  }

  chip.setAttribute('aria-describedby', POPOVER_ID);
  chip.setAttribute('aria-expanded', 'true');
  currentChip = chip;
  if (pin) pinned = true;
  else if (!reusingChip) pinned = false;
  positionPopover(popoverEl, chip);
}

function wireChip(chip: HTMLAnchorElement, footnoteMap: Map<string, FootnoteEntry>) {
  if (chip.classList.contains(CHIP_CLASS)) return; // already wired
  const id = (chip.getAttribute('href') ?? '').replace(/^#/, '');
  const entry = footnoteMap.get(id);
  if (!entry) return;

  // VitePress installs its own window-level, capture-phase click listener
  // that intercepts same-page hash links and scrolls to them itself, before
  // this chip's own click handler ever runs - calling preventDefault() there
  // is too late to stop it. Dropping `href` keeps the chip out of that
  // interceptor entirely (it only inspects elements with an href), so the
  // popover is the only thing a click produces, with no jump to the
  // page-bottom footnote and back.
  chip.removeAttribute('href');
  chip.setAttribute('role', 'button');
  chip.tabIndex = 0;
  chip.classList.add(CHIP_CLASS);
  chip.setAttribute('aria-haspopup', 'true');
  chip.setAttribute('aria-expanded', 'false');
  chip.textContent = id.replace(/^fn/, '');

  const togglePinned = () => {
    if (currentChip === chip && pinned) close();
    else open(chip, entry, true);
  };

  chip.addEventListener('mouseenter', () => open(chip, entry, false));
  chip.addEventListener('mouseleave', scheduleClose);
  chip.addEventListener('focus', () => open(chip, entry, false));
  chip.addEventListener('blur', scheduleClose);
  chip.addEventListener('click', togglePinned);
  chip.addEventListener('keydown', (event) => {
    // A no-href <a> isn't a native button, so Enter/Space activation needs
    // wiring by hand to keep the chip keyboard-operable after tabIndex=0.
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      togglePinned();
    }
  });
}

function bindGlobalListeners() {
  if (globalListenersBound) return;
  globalListenersBound = true;
  document.addEventListener('click', (event) => {
    if (!pinned || !currentChip) return;
    const target = event.target as Node;
    if (currentChip.contains(target) || popoverEl?.contains(target)) return;
    close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
}

// Called on initial mount and after every client-side route change (each
// tuning-reference page renders its own footnotes list from scratch).
export function setupCitationChips(): void {
  close();
  bindGlobalListeners();
  const footnoteMap = buildFootnoteMap();
  document.querySelectorAll<HTMLAnchorElement>('sup.footnote-ref > a[href]').forEach((chip) => {
    wireChip(chip, footnoteMap);
  });
}

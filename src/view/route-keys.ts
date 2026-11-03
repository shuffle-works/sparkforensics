import type { EvidenceKey } from '@sparkforensics/core/types.ts';

// The keys a route lands on. They sit apart from the layout, which pulls in every widget, so a card or
// a row can name its landing without importing the board.

type ImpactBand = 'critical' | 'warning' | 'info';

export const VERDICT_LANDMARK = 'verdict';
export const BOARD_LANDMARK = 'board';
export const FILTERS_LANDMARK = 'filters';
export const EVIDENCE_CARD_KEY = 'reference-evidence-availability';

export const bandLandmark = (band: ImpactBand) => `band:${band}`;
export const referenceWidgetKey = (widgetId: string) => `reference-${widgetId}`;
export const evidenceRowKey = (key: EvidenceKey) => `evidence:${key}`;
/** The row key of the element a landmark route lands on. */
export const landmarkRowKey = (id: string) => `landmark:${id}`;
/** The row key of a card's own title, which a route lands on when the card lists no row for its finding. */
export const cardLandingKey = (cardKey: string) => `card:${cardKey}`;

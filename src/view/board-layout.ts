import type { ComponentType } from 'react';

import { IMPACT_BANDS } from '@sparkforensics/core/view-model';
import type { InterpretedStep } from '@sparkforensics/core/analysis';
import type { AppModel, EvidenceKey, Finding, FindingType } from '@sparkforensics/core/types';
import type { BoardTab, ResolvedRoute } from '@/store/board';
import type { InterpretationState } from '@/view/interpretation';
import { evidencePanelFor, isAlwaysMountedType, REGISTRY, registryTypes, type WidgetProps } from '@/view/detector-registry';
import type { AnyEvidencePanel } from '@/view/evidence-panel';
import { filterFindings, type FilterSelection } from '@/view/finding-filter';
import { bandLandmark, BOARD_LANDMARK, cardLandingKey, EVIDENCE_CARD_KEY, evidenceRowKey, FILTERS_LANDMARK, landmarkRowKey, referenceWidgetKey, VERDICT_LANDMARK } from '@/view/route-keys';
import { runFindingKeys } from '@/view/finding-keys';
import { boardRollup, findingById, type BoardGroup } from '@/view/interpretation';
import { triageTargetFor, type TriageTarget } from '@/view/triage-target';
import { verdictEvidenceOwners, verdictLeadFindings } from '@/view/verdict-evidence';
import { computeActiveWidgets, widgetFindings, widgetRowFindings, type ActiveWidget } from '@/view/widgets/Alerts';
import { hasCoreUsageHistogram } from '@/view/widgets/CoreUsageHistogram';
import { hasEfficiencyModel } from '@/view/widgets/EfficiencyModel';
import { hasEtlPhases } from '@/view/widgets/EtlPhases';
import { hasScalingSim } from '@/view/widgets/ScalingSim';

// Which cards the board has, in which tab and order, and which rows each card lists, decided once
// from the run's interpretation, the finding filter and the density. Views render this and routes
// resolve against it (`resolveRoute`); nothing about the board is learned from the mounted DOM.

export type ImpactBand = Finding['impactBand'];

const NOTHING_STATED: readonly Finding[] = [];

/** The evidence a verdict step shows in place of its widget's card. A `panel` step has evidence to
 * show and offers the control for it. A `bare` step has nothing beyond the step line: no control,
 * and a route to it lands on the step. No evidence at all (null) means the step routes to the
 * widget's card. */
export type StepEvidence =
  | { kind: 'panel'; widgetId: string; panel: AnyEvidencePanel; cardKey: string; widget: ActiveWidget }
  | { kind: 'bare'; widgetId: string };

/** How a board row shows its evidence: `panel` is what its card expands to in place, scoped to the
 * row's findings. A row whose widget has nothing to show beyond the row has `widget` and no panel. */
export interface RowEvidence {
  widget: ActiveWidget | null;
  panel: AnyEvidencePanel | null;
  cardKey: string | null;
}

export interface StepLayout {
  index: number;
  step: InterpretedStep;
  finding: Finding;
  /** The step's focusable line. */
  lineKey: string;
  evidence: StepEvidence | null;
}

export interface FindingRowLayout {
  kind: 'finding';
  lineKey: string;
  finding: Finding;
  evidence: RowEvidence;
}

export interface GroupRowLayout {
  kind: 'group';
  lineKey: string;
  group: BoardGroup;
  evidence: RowEvidence;
  /** One line per member, shown while the group is expanded. */
  memberLineKeys: readonly string[];
}

export type BoardRowLayout = FindingRowLayout | GroupRowLayout;

export interface BandLayout {
  band: ImpactBand;
  rows: readonly BoardRowLayout[];
  /** Evidence cards under the rows, collapsed: those no step or row shows in place, and, once a
   * route reveals them, the cards a step or row already shows in place. */
  cards: readonly BoardCard[];
  /** The keys of the cards that appear only once a route has revealed them. */
  routeOnlyCardKeys: ReadonlySet<string>;
  /** Whether the band shows its heading before any route: it has a row or a card of its own. */
  listed: boolean;
}

export interface BoardCard {
  key: string;
  widget: ActiveWidget;
}

export type ReferenceCard =
  | { key: string; kind: 'widget'; component: ComponentType<WidgetProps> }
  | { key: string; kind: 'evidence-availability' | 'etl-phases' | 'scaling-sim' | 'efficiency-model' | 'core-usage-histogram' };

/** A card the board can open: an evidence panel inside a step or row (no tab of its own, or the
 * Findings tab for a row), or a widget card under a band's rows or in the Full app report. */
export interface LayoutCard {
  key: string;
  tab: BoardTab | null;
  /** The keys of the findings the card's rows stand for, in row order. */
  rowKeys: readonly string[];
}

/** A control the triage shortcuts step through. */
export interface LayoutLine {
  key: string;
  /** The group line a member line belongs to: it is walked only while that group is expanded. */
  parent: string | null;
}

interface Holder {
  /** The step or row line that holds the finding, and its evidence panel card. */
  line: { key: string; cardKey: string | null; tab: BoardTab | null; bare: boolean } | null;
  /** The widget card listing the finding. */
  card: { key: string; tab: BoardTab } | null;
}

export interface BoardLayout {
  /** The run's key for a finding, unique among the run's findings. */
  keyOf: (finding: Finding) => string;
  steps: readonly StepLayout[];
  bands: readonly BandLayout[];
  reference: readonly ReferenceCard[];
  cards: ReadonlyMap<string, LayoutCard>;
  /** Steps first, then each band's rows, in reading order. */
  lines: readonly LayoutLine[];
  /** What the Findings tab lists: eligible findings the filter keeps, less the steps' leads. */
  listedCount: number;
  verdictLeads: ReadonlySet<Finding>;
  /** The finding types with a widget over the unfiltered run: every other type is a clean check. */
  evidenceTypes: ReadonlySet<string>;
  holders: ReadonlyMap<string, Holder>;
  /** Evidence-availability ledger rows, by evidence key. */
  evidenceKeys: ReadonlySet<EvidenceKey>;
}

export interface BoardLayoutInput {
  interpretation: InterpretationState | null;
  appModel: AppModel;
  catalog: readonly Finding[];
  configFindings: readonly Finding[];
  selection: FilterSelection;
  density: 'basic' | 'advanced';
}

const stepLineKey = (step: InterpretedStep) => `step:${step.key}`;

/** A panel's card key: its widget's slot and the key of the first finding it is scoped to, so two panels of one widget never share a disclosure. */
const panelCardKey = (widget: ActiveWidget, scope: readonly Finding[], keyOf: (finding: Finding) => string) => `alert-${widget.index}-${scope[0] ? keyOf(scope[0]) : 'none'}`;

/** The evidence panel `widget` shows for `scope` beyond what the line above states (`stated`), or
 * null when it has nothing to show or no widget. */
export function evidencePanelOf(
  widget: ActiveWidget | null | undefined,
  appModel: AppModel,
  scope: readonly Finding[],
  stated: readonly Finding[],
  density: 'basic' | 'advanced',
  interpretation: InterpretationState | null,
): AnyEvidencePanel | null {
  if (!widget) return null;
  const ids = new Set(stated.flatMap((finding) => (finding.id != null ? [finding.id] : [])));
  return evidencePanelFor(widget.type, { findings: scope, stated: ids, density, appModel, localityChart: interpretation?.data.coreLocality?.chart });
}

export function rowEvidence(
  widget: ActiveWidget | null,
  scope: readonly Finding[],
  stated: readonly Finding[],
  input: BoardLayoutInput,
  keyOf: (finding: Finding) => string,
): RowEvidence {
  const panel = evidencePanelOf(widget, input.appModel, scope, stated, input.density, input.interpretation);
  return { widget, panel, cardKey: widget && panel ? panelCardKey(widget, scope, keyOf) : null };
}

/** The board's layout for a run under `selection` and `density`. Pure: the same inputs give the same
 * cards, rows and order, whatever is mounted. */
export function buildBoardLayout(input: BoardLayoutInput): BoardLayout {
  const { interpretation, appModel, selection, density } = input;
  const catalog = [...input.catalog];
  const configFindings = [...input.configFindings];
  const keyOf = runFindingKeys([...catalog, ...configFindings]);
  const cards = new Map<string, LayoutCard>();
  const holders = new Map<string, Holder>();
  const lines: LayoutLine[] = [];
  const holder = (finding: Finding): Holder => {
    const key = keyOf(finding);
    let entry = holders.get(key);
    if (!entry) {
      entry = { line: null, card: null };
      holders.set(key, entry);
    }
    return entry;
  };
  const rowKeysOf = (findings: readonly Finding[]) => [...new Set(findings.map(keyOf))];
  const detectors = interpretation?.data.detectors;

  // The verdict owns the steps' findings and their evidence; the Findings tab lists the rest. Its
  // cards come from the unfiltered catalog.
  const evidenceWidgets = detectors ? computeActiveWidgets(catalog, configFindings, detectors, appModel, density) : [];
  const evidenceTypes = new Set(evidenceWidgets.map((widget) => widget.type));
  const verdictLeads = new Set<Finding>(interpretation ? verdictLeadFindings(interpretation) : []);
  const owners = interpretation ? verdictEvidenceOwners(interpretation, new Set(evidenceWidgets.map((widget) => widget.widgetId))) : new Map<number, string>();
  const verdictWidgetIds = new Set(owners.values());

  const steps: StepLayout[] = [];
  interpretation?.data.verdict.steps.forEach((step, index) => {
    const finding = findingById(interpretation, step.leadId);
    if (!finding) return;
    const lineKey = stepLineKey(step);
    const widgetId = owners.get(index);
    const widget = widgetId ? evidenceWidgets.find((candidate) => candidate.widgetId === widgetId) : undefined;
    const panel = widgetId ? evidencePanelOf(widget, appModel, [finding], [finding], density, interpretation) : null;
    const evidence: StepEvidence | null = !widgetId ? null
      : panel && widget ? { kind: 'panel', widgetId, panel, cardKey: panelCardKey(widget, [finding], keyOf), widget }
        : { kind: 'bare', widgetId };
    steps.push({ index, step, finding, lineKey, evidence });
    lines.push({ key: lineKey, parent: null });
    holder(finding).line = { key: lineKey, cardKey: evidence?.kind === 'panel' ? evidence.cardKey : null, tab: null, bare: evidence?.kind === 'bare' };
    if (evidence?.kind === 'panel') {
      cards.set(evidence.cardKey, { key: evidence.cardKey, tab: null, rowKeys: rowKeysOf(evidence.panel.rows) });
    }
  });

  // The Findings tab: the filtered streams, less what the steps lead with.
  const filteredCatalog = filterFindings(catalog, selection);
  const filteredConfig = filterFindings(configFindings, selection);
  const rest = (findings: Finding[]) => findings.filter((finding) => !verdictLeads.has(finding));
  const { groups, eligible } = boardRollup(interpretation, [...rest(filteredCatalog), ...rest(filteredConfig)], appModel.stages);
  const listedCount = eligible.length;
  const boardWidgets = detectors ? computeActiveWidgets(filteredCatalog, filteredConfig, detectors, appModel, density) : [];
  /** The findings `model` lists under the filter, in row order. */
  const listedRows = (type: FindingType) =>
    widgetRowFindings(type, { catalog: filteredCatalog, configFindings: filteredConfig, stated: new Set(), density, appModel });
  const widgetOf = (finding: Finding) => {
    const widgetId = triageTargetFor(finding)?.widgetId;
    return widgetId ? boardWidgets.find((widget) => widget.widgetId === widgetId) ?? null : null;
  };

  const claimed = new Set(verdictWidgetIds);
  const bandRows = new Map<ImpactBand, BoardRowLayout[]>();
  for (const group of groups) {
    const widget = widgetOf(group.findings[0]);
    if (widget) claimed.add(widget.widgetId);
    let row: BoardRowLayout;
    if (group.findings.length === 1) {
      const finding = group.findings[0];
      const lineKey = `row:${keyOf(finding)}`;
      const evidence = rowEvidence(widget, [finding], [finding], input, keyOf);
      row = { kind: 'finding', lineKey, finding, evidence };
    } else {
      const lineKey = `group:${group.key}`;
      const evidence = rowEvidence(widget, group.findings, NOTHING_STATED, input, keyOf);
      row = { kind: 'group', lineKey, group, evidence, memberLineKeys: group.findings.map((member) => `member:${keyOf(member)}`) };
    }
    const members = row.kind === 'group' ? group.findings : [row.finding];
    const bare = row.evidence.widget != null && row.evidence.panel == null;
    for (const member of members) holder(member).line = { key: row.lineKey, cardKey: row.evidence.cardKey, tab: 'findings', bare };
    if (row.evidence.cardKey && row.evidence.widget && row.evidence.panel) {
      cards.set(row.evidence.cardKey, { key: row.evidence.cardKey, tab: 'findings', rowKeys: rowKeysOf(row.evidence.panel.rows) });
    }
    const rows = bandRows.get(group.band) ?? [];
    rows.push(row);
    bandRows.set(group.band, rows);
  }

  const bandCards = new Map<ImpactBand, BoardCard[]>();
  const routeOnlyKeys = new Set<string>();
  for (const widget of boardWidgets) {
    const key = `alert-${widget.index}`;
    const isClaimed = claimed.has(widget.widgetId);
    cards.set(key, { key, tab: 'findings', rowKeys: rowKeysOf(listedRows(widget.type)) });
    for (const finding of widget.findings) holder(finding).card = { key, tab: 'findings' };
    if (isClaimed) routeOnlyKeys.add(key);
    const list = bandCards.get(widget.impactBand) ?? [];
    list.push({ key, widget });
    bandCards.set(widget.impactBand, list);
  }

  const bands: BandLayout[] = [];
  for (const band of IMPACT_BANDS) {
    const rows = bandRows.get(band) ?? [];
    const bandWidgetCards = bandCards.get(band) ?? [];
    if (rows.length === 0 && bandWidgetCards.length === 0) continue;
    const routeOnlyCardKeys = new Set(bandWidgetCards.filter(({ key }) => routeOnlyKeys.has(key)).map(({ key }) => key));
    bands.push({ band, rows, cards: bandWidgetCards, routeOnlyCardKeys, listed: rows.length > 0 || routeOnlyCardKeys.size < bandWidgetCards.length });
    for (const row of rows) {
      if (row.kind === 'group' || row.evidence.widget) lines.push({ key: row.lineKey, parent: null });
      if (row.kind === 'group' && row.evidence.panel) lines.push({ key: `${row.lineKey}:evidence`, parent: null });
      if (row.kind === 'group') for (const memberKey of row.memberLineKeys) lines.push({ key: memberKey, parent: row.lineKey });
    }
  }

  // The Full app report: the reference widgets the data has content for.
  const reference: ReferenceCard[] = [];
  for (const type of registryTypes()) {
    if (!isAlwaysMountedType(type)) continue;
    const entry = REGISTRY[type];
    const key = referenceWidgetKey(entry.widgetId);
    reference.push({ key, kind: 'widget', component: entry.component });
    cards.set(key, { key, tab: 'full-report', rowKeys: rowKeysOf(listedRows(type)) });
    // The card is on the page whatever the filter keeps, so a route to any finding of its type lands on it.
    for (const finding of widgetFindings(type, { catalog, configFindings })) holder(finding).card = { key, tab: 'full-report' };
  }
  const evidenceKeys = new Set<EvidenceKey>(appModel.evidenceAvailability?.entries.map((entry) => entry.key) ?? []);
  reference.push({ key: EVIDENCE_CARD_KEY, kind: 'evidence-availability' });
  cards.set(EVIDENCE_CARD_KEY, { key: EVIDENCE_CARD_KEY, tab: 'full-report', rowKeys: [...evidenceKeys].map(evidenceRowKey) });
  if (hasEtlPhases(interpretation)) reference.push({ key: 'reference-etl-phases', kind: 'etl-phases' });
  if (hasScalingSim(appModel, interpretation)) reference.push({ key: 'reference-scaling-sim', kind: 'scaling-sim' });
  if (hasEfficiencyModel(interpretation)) reference.push({ key: 'reference-efficiency-model', kind: 'efficiency-model' });
  if (hasCoreUsageHistogram(appModel)) reference.push({ key: 'reference-core-usage-histogram', kind: 'core-usage-histogram' });
  for (const card of reference) {
    if (!cards.has(card.key)) cards.set(card.key, { key: card.key, tab: 'full-report', rowKeys: [] });
  }

  return { keyOf, steps, bands, reference, cards, lines, listedCount, verdictLeads, evidenceTypes, holders, evidenceKeys };
}

/** What a route asks for. */
export type RouteTarget =
  | TriageTarget
  | { kind: 'evidence'; key: EvidenceKey }
  /** A heading or region the page scrolls to: the verdict, the Findings board, or an impact band. */
  | { kind: 'landmark'; id: string };


/** Where a route to `target` lands in `layout`, or null when the layout has no place for it (a
 * finding the filter or the run does not list, an evidence key the ledger lacks). */
export function resolveRoute(target: RouteTarget, layout: BoardLayout): ResolvedRoute | null {
  if ('finding' in target) return resolveFinding(target.finding, layout);
  if (target.kind === 'evidence') {
    if (!layout.evidenceKeys.has(target.key)) return null;
    return { tab: 'full-report', openCards: [EVIDENCE_CARD_KEY], cardKey: EVIDENCE_CARD_KEY, rowKey: evidenceRowKey(target.key) };
  }
  if (target.id === VERDICT_LANDMARK) return { tab: null, openCards: [], cardKey: null, rowKey: landmarkRowKey(VERDICT_LANDMARK) };
  if (target.id === FILTERS_LANDMARK) return { tab: null, openCards: [], cardKey: null, rowKey: landmarkRowKey(FILTERS_LANDMARK) };
  if (target.id === BOARD_LANDMARK) return { tab: 'findings', openCards: [], cardKey: null, rowKey: landmarkRowKey(BOARD_LANDMARK) };
  const band = IMPACT_BANDS.find((candidate) => bandLandmark(candidate) === target.id);
  if (band && layout.bands.some((entry) => entry.band === band && entry.listed)) return { tab: 'findings', openCards: [], cardKey: null, rowKey: landmarkRowKey(target.id) };
  return null;
}

function resolveFinding(finding: Finding, layout: BoardLayout): ResolvedRoute | null {
  const key = layout.keyOf(finding);
  const held = layout.holders.get(key);
  if (!held) return null;
  const { line, card } = held;
  // A step or row with an evidence panel opens it and lands on the finding's own row inside.
  if (line?.cardKey) return { tab: line.tab, openCards: [line.cardKey], cardKey: line.cardKey, rowKey: key };
  // A step or row whose widget has nothing beyond it is the landing itself.
  if (line?.bare) return { tab: line.tab, openCards: [], cardKey: null, rowKey: line.key };
  if (card) {
    const listed = layout.cards.get(card.key)?.rowKeys.includes(key) ?? false;
    return { tab: card.tab, openCards: [card.key], cardKey: card.key, rowKey: listed ? key : cardLandingKey(card.key) };
  }
  return null;
}

/** The lines j/k step through: the steps, then the board's rows, with a group's members only while
 * that group is expanded. */
export function walkableLines(layout: BoardLayout, expandedGroupLineKey: string | null): readonly string[] {
  return layout.lines.filter((line) => line.parent === null || line.parent === expandedGroupLineKey).map((line) => line.key);
}

<script setup lang="ts">
import { computed } from 'vue';
import data from '../detectors-data.json';
import { FIX_EFFORT_LABEL, SCOPE_LABEL, sentenceCase, siteHref, type DetectorData } from './detectors';

const props = defineProps<{ type: string }>();

const { families, records } = data as unknown as DetectorData;
const r = computed(() => records.find((x) => x.type === props.type)!);
const familyLabel = computed(() => families.find((f) => f.id === r.value.family)?.label ?? r.value.family);
const sharedWith = computed(() =>
  r.value.tagSharedWith.map((t) => records.find((x) => x.type === t)).filter((x) => x !== undefined),
);

const example = computed(() => r.value.example);
const finding = computed(() => example.value?.finding ?? null);

// Compact text for an evidence value: scalars as is, structures as short JSON.
function evidenceText(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value !== 'object') return String(value);
  const text = JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}
const evidenceRows = computed(() => Object.entries(finding.value?.evidence ?? {}).map(([k, v]) => [k, evidenceText(v)]));

function remediationText(step: Record<string, unknown>): string {
  if (step.kind === 'code') return String(step.hint);
  const suggested = step.suggested === null || step.suggested === undefined ? '' : ` to ${String(step.suggested)}`;
  return `${String(step.direction)} ${String(step.key)}${suggested}`;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

const tuningLink = computed(() => {
  const t = r.value.tuning;
  if (!t) return null;
  const lead = { page: 'This finding has its own tuning page', section: 'This finding is covered in a section of a tuning page', chapter: 'This finding is covered in a general tuning chapter' }[t.kind];
  return { lead, href: siteHref(t.path) };
});

const airflowSnippet = computed(() => {
  const gate = r.value.gate;
  const budget = gate
    ? `    ${gate.airflowParam}=...,  # your budget\n`
    : '    baseline_log_source=...,\n    fail_on_introduced="critical",\n';
  return `check_spark_job = SparkForensicsOperator(\n    task_id="check_spark_job",\n    log_source=...,\n    backend=SubprocessAnalyzeHook(),\n${budget})`;
});
</script>

<template>
  <main id="main-content" class="det-page">
    <p class="det-crumb"><a :href="siteHref('docs/detectors/')">Detector catalog</a> / {{ familyLabel }}</p>

    <!-- Lead block: the finding in plain words. -->
    <header class="det-lead">
      <div class="det-title"><span class="sf-chip sf-chip-lg">{{ r.tag }}</span><h1>{{ sentenceCase(r.name) }}</h1></div>
      <p class="det-standfirst">{{ r.pitch }}</p>
      <dl class="det-facts">
        <div><dt>Outcome</dt><dd>{{ familyLabel }}</dd></div>
        <div><dt>Scope</dt><dd>{{ SCOPE_LABEL[r.scope] }}</dd></div>
        <div><dt>Usual fix</dt><dd>{{ FIX_EFFORT_LABEL[r.fixEffort] }}</dd></div>
        <div v-if="r.region === 'reference'">
          <dt>Dashboard</dt>
          <dd>Shown in the reference region, below the action widgets. It informs; it does not rank a fix.</dd>
        </div>
        <div>
          <dt>CI gate</dt>
          <dd v-if="r.gate">Budget flag <code>{{ r.gate.cliFlag }}</code></dd>
          <dd v-else>No budget flag: gate it with <code>--fail-on-introduced</code> against a baseline</dd>
        </div>
      </dl>
    </header>

    <!-- Finding card, built from the real example finding. -->
    <section v-if="finding" class="det-section" aria-labelledby="det-example">
      <h2 id="det-example">An example finding</h2>
      <p v-if="example!.source === 'synthetic'" class="det-note">
        <strong>A synthetic example.</strong> A small event log built to fire this detector at its default thresholds,
        <code>{{ example!.log }}</code>{{ example!.sparkVersion ? ` (Spark ${example!.sparkVersion})` : '' }}, read by the real analyzer.
        It is not a real production run.
      </p>
      <p v-else class="det-note">
        A finding as reported, from the public {{ example!.source === 'corpus' ? 'corpus' : 'test' }} log <code>{{ example!.log }}</code>{{ example!.sparkVersion ? ` (Spark ${example!.sparkVersion})` : '' }}.
      </p>
      <article class="det-finding" :data-band="finding.impactBand">
        <header class="det-finding-head">
          <span class="det-dot" :data-band="finding.impactBand" aria-hidden="true"></span>
          <span class="sf-chip">{{ finding.tag }}</span>
          <strong class="det-finding-name">{{ finding.name }}</strong>
          <span class="det-band">{{ finding.impactBand }}</span>
          <span v-if="example!.source === 'synthetic'" class="det-band">synthetic example</span>
          <span v-if="finding.stageId !== undefined && finding.stageId !== null" class="det-stage">Stage {{ finding.stageId }}</span>
        </header>
        <p class="det-reco">{{ finding.recommendation }}</p>
        <p class="det-impact">
          <template v-if="finding.impact"><strong>Impact</strong> {{ finding.impact }} {{ finding.impactMeaning }}
          <span class="det-sep">·</span> </template><strong>Confidence</strong> {{ finding.confidence ?? 'not rated' }}
        </p>
        <p v-if="finding.estimateProvenance" class="det-small">{{ finding.estimateProvenance }}</p>
        <p v-if="finding.validationRequired" class="det-small">{{ finding.validationRequired }}</p>
        <ul v-if="finding.remediation?.length" class="det-fix">
          <li v-for="(step, i) in finding.remediation" :key="i">{{ finding.actionLabel }}: {{ remediationText(step) }}</li>
        </ul>
        <dl v-if="evidenceRows.length" class="det-evidence">
          <template v-for="[key, value] in evidenceRows" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template>
        </dl>
      </article>
    </section>
    <section v-else class="det-section" aria-labelledby="det-example">
      <h2 id="det-example">An example finding</h2>
      <article class="det-finding det-finding-empty">
        <header class="det-finding-head"><strong class="det-finding-name">No public example log yet</strong></header>
        <p class="det-reco">No log in the public corpus triggers this finding, so there is no real example to show.</p>
        <p class="det-impact"><strong>It fires when</strong> {{ r.thresholdSummary }}</p>
        <p class="det-small">{{ r.pitch }}</p>
      </article>
    </section>

    <!-- The four surfaces, each with output captured from a real run. -->
    <section class="det-section" aria-labelledby="det-surfaces">
      <h2 id="det-surfaces">Where you see it</h2>

      <h3 id="det-dashboard">Dashboard</h3>
      <p>
        The <span class="sf-chip">{{ r.tag }}</span> tag marks it in the
        {{ r.region === 'reference' ? 'reference region of the dashboard, below the action widgets' : 'action region of the dashboard, among the widgets that rank a fix' }}.
        <template v-if="r.scope === 'stage'">Every affected stage is flagged, not only the worst.</template>
        <a :href="siteHref(r.pages.guide)">How to read it in the findings guide</a>.
      </p>

      <h3 id="det-agent">Agent (MCP)</h3>
      <p>
        An assistant can read this entry with the <code>list_detectors</code> tool and its background with
        <code>get_finding_documentation</code>. The call and the response below come from a real run of the MCP server.
      </p>
      <p class="det-label">Call</p>
      <pre class="det-code"><code>{{ json(r.surfaces.mcp.listCall) }}</code></pre>
      <p class="det-label">Response</p>
      <pre class="det-code"><code>{{ json(r.surfaces.mcp.listResponse) }}</code></pre>
      <p class="det-label">get_finding_documentation call</p>
      <pre class="det-code"><code>{{ json(r.surfaces.mcp.docsCall) }}</code></pre>
      <p class="det-label">Its response, with each Markdown body replaced by its length</p>
      <pre class="det-code"><code>{{ json(r.surfaces.mcp.docsResponse) }}</code></pre>

      <h3 id="det-ci">CI (CLI)</h3>
      <p>
        List this entry from the command line. The output below is a real run of the command. Budgets and exit codes are in the
        <a :href="siteHref('docs/user-guide/getting-started/ci-and-automation.html')">CI guide</a>.
      </p>
      <pre class="det-code"><code>{{ r.surfaces.cli.detectorsCommand }}</code></pre>
      <pre class="det-code det-output"><code>{{ r.surfaces.cli.detectorsOutput }}</code></pre>
      <p>Report only this finding type for a run with <code>--type</code>:</p>
      <pre class="det-code"><code>{{ r.surfaces.cli.filterCommand }}</code></pre>
      <template v-if="r.surfaces.cli.budgetCommand">
        <p>Fail the build when the run breaches a budget for it:</p>
        <pre class="det-code"><code>{{ r.surfaces.cli.budgetCommand }}</code></pre>
      </template>
      <p v-else>
        It has no budget flag. Fail a build on a new one by comparing against a baseline with
        <code>--fail-on-introduced</code>.
      </p>

      <h3 id="det-airflow">Airflow</h3>
      <p v-if="r.gate">The operator takes the budget as the <code>{{ r.gate.airflowParam }}</code> parameter.</p>
      <p v-else>The operator has no budget parameter for it. Use <code>fail_on_introduced</code> with a baseline.</p>
      <pre class="det-code"><code>{{ airflowSnippet }}</code></pre>
      <p>
        The operator works per run, and its summary counts findings per impact band. See the
        <a href="https://github.com/shuffle-works/sparkforensics-operator">operator</a> for its parameters.
      </p>
    </section>

    <!-- Thresholds and docs. -->
    <section class="det-section det-measured" aria-labelledby="det-measured">
      <h2 id="det-measured">How it is measured</h2>

      <h3 id="det-thresholds">Thresholds</h3>
      <p>{{ sentenceCase(r.thresholdSummary) }}.</p>
      <div v-for="(d, i) in r.detectors" :key="i" class="det-threshold">
        <p class="det-label">
          <code>{{ d.detector }}</code> version {{ d.version }}<template v-if="r.detectors.length > 1">, check {{ i + 1 }} of {{ r.detectors.length }}</template>
        </p>
        <div class="det-table-wrap">
          <table>
            <thead><tr><th>Threshold</th><th>Default</th></tr></thead>
            <tbody>
              <tr v-for="(value, name) in d.thresholds" :key="name"><td><code>{{ name }}</code></td><td>{{ evidenceText(value) }}</td></tr>
              <tr v-if="Object.keys(d.thresholds).length === 0"><td colspan="2">No thresholds.</td></tr>
            </tbody>
          </table>
        </div>
        <p v-if="d.suppressedBy" class="det-small">
          Suppressed by <code>{{ d.suppressedBy }}</code>: this detector drops its finding on any stage
          <code>{{ d.suppressedBy }}</code> flagged in the same run.
        </p>
      </div>
      <p class="det-small">Each rule's impact bands and fixed fallbacks are in the <a :href="siteHref('docs/contributor-guide/architecture/detector-contract/threshold-tables.html')">threshold tables</a>.</p>
      <p class="det-small">Override a default per run with <code>--thresholds</code>; see <a :href="siteHref('docs/user-guide/getting-started/tuning-thresholds.html')">Tuning detector thresholds</a>.</p>

      <h3 id="det-docs">Docs</h3>
      <ul class="det-links">
        <li v-if="tuningLink">{{ tuningLink.lead }}: <a :href="tuningLink.href">Spark tuning reference</a>.</li>
        <li v-else>There is no tuning page for this type.</li>
        <li>Findings guide: <a :href="siteHref(r.pages.guide)">{{ r.tag }} in Understanding findings</a>.</li>
        <li v-if="sharedWith.length">
          Shares the {{ r.tag }} tag with:
          <template v-for="(other, i) in sharedWith" :key="other!.type">
            <a :href="siteHref(other!.pages.catalog)">{{ other!.name }}</a>{{ i < sharedWith.length - 1 ? ', ' : '' }}
          </template>.
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.det-page { max-width: 860px; margin: 0 auto; padding: 0 0 48px; }
.det-crumb { margin: 0 0 14px; font-size: 13px; color: var(--sf-muted); }
.det-lead { margin-bottom: 8px; }
.det-title { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.det-title h1 { margin: 0; font-size: 32px; line-height: 1.2; letter-spacing: -0.01em; }
.det-standfirst { margin: 14px 0 20px; max-width: 60ch; font-size: 18px; line-height: 1.55; color: var(--sf-ink); }
.det-facts {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0;
  margin: 0; border: 1px solid var(--sf-rule); border-radius: 6px; background: var(--sf-surface-2); overflow: hidden;
}
.det-facts > div { padding: 12px 16px; box-shadow: 1px 1px 0 0 var(--sf-rule); }
.det-facts dt { font-family: var(--vp-font-family-mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sf-muted); }
.det-facts dd { margin: 4px 0 0; font-size: 14px; line-height: 1.45; }
.det-section { margin-top: 36px; }
.det-section h2 { margin: 0 0 12px; padding-top: 0; border-top: 0; font-size: 22px; }
.det-section h3 { margin: 28px 0 8px; font-size: 17px; }
.det-note { margin: 0 0 12px; font-size: 14px; color: var(--sf-muted); }
.det-label { margin: 14px 0 4px; font-size: 13px; color: var(--sf-muted); }
.det-small { margin: 6px 0 0; font-size: 13px; line-height: 1.5; color: var(--sf-muted); }

.det-finding { border: 1px solid var(--sf-rule); border-left: 3px solid var(--sf-muted); border-radius: 6px; background: var(--sf-panel); padding: 14px 18px 16px; }
.det-finding[data-band='critical'] { border-left-color: var(--sf-critical); }
.det-finding[data-band='warning'] { border-left-color: var(--sf-warning); }
.det-finding[data-band='info'] { border-left-color: var(--sf-info); }
.det-finding-empty { border-left-style: dashed; background: var(--sf-surface-2); }
.det-finding-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.det-finding-name { font-size: 16px; }
.det-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--sf-muted); flex: none; }
.det-dot[data-band='critical'] { background: var(--sf-critical); }
.det-dot[data-band='warning'] { background: var(--sf-warning); }
.det-dot[data-band='info'] { background: var(--sf-info); }
.det-band { font-family: var(--vp-font-family-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sf-muted); }
.det-stage { margin-left: auto; font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--sf-muted); }
.det-reco { margin: 12px 0 8px; line-height: 1.55; }
.det-impact { margin: 0; font-size: 14px; }
.det-sep { margin: 0 6px; color: var(--sf-muted); }
.det-fix { margin: 10px 0 0; padding-left: 18px; font-size: 14px; }
.det-evidence {
  display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 14px 0 0; padding-top: 12px;
  border-top: 1px solid var(--sf-rule-soft); font-size: 13px;
}
.det-evidence dt { font-family: var(--vp-font-family-mono); color: var(--sf-muted); }
.det-evidence dd { margin: 0; overflow-wrap: anywhere; font-family: var(--vp-font-family-mono); }

.det-code {
  margin: 6px 0 10px; padding: 12px 16px; overflow-x: auto; border: 1px solid var(--sf-rule); border-radius: 6px;
  background: var(--sf-surface-2); font-family: var(--vp-font-family-mono); font-size: 13px; line-height: 1.55;
}
.det-code code { background: none; padding: 0; font-size: inherit; color: var(--sf-ink); white-space: pre; }
.det-table-wrap { overflow-x: auto; }
.det-table-wrap table { display: table; width: 100%; margin: 6px 0; }
.det-links { margin: 8px 0 0; }

@media (max-width: 640px) {
  .det-title h1 { font-size: 26px; }
  .det-standfirst { font-size: 16px; }
  .det-finding { padding: 12px 14px 14px; }
  .det-evidence { grid-template-columns: 1fr; gap: 0; }
  .det-evidence dd { margin-bottom: 6px; }
}
</style>

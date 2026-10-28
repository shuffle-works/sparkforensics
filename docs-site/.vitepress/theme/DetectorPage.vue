<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { HEIGHT_MESSAGE } from '../../../src/docs-widget/host';
import data from '../detectors-data.json';
import { EXAMPLE_SOURCE_LABEL, FIX_EFFORT_LABEL, SCOPE_LABEL, exampleFrameSrc, sentenceCase, siteHref, type DetectorData } from './detectors';

const props = defineProps<{ type: string }>();

const { families, records } = data as unknown as DetectorData;
const r = computed(() => records.find((x) => x.type === props.type)!);
const familyLabel = computed(() => families.find((f) => f.id === r.value.family)?.label ?? r.value.family);
const sharedWith = computed(() =>
  r.value.tagSharedWith.map((t) => records.find((x) => x.type === t)).filter((x) => x !== undefined),
);

// The example is the dashboard's own widget in a frame (docs-widget.html). The frame reports its
// content height; until it does, it holds room for a typical card.
const frame = ref<HTMLIFrameElement | null>(null);
const frameHeight = ref(480);
function onFrameMessage(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow || event.data?.type !== HEIGHT_MESSAGE) return;
  frameHeight.value = event.data.height;
}
onMounted(() => window.addEventListener('message', onFrameMessage));
onBeforeUnmount(() => window.removeEventListener('message', onFrameMessage));

// Compact text for a threshold value: scalars as is, structures as short JSON.
function thresholdText(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value !== 'object') return String(value);
  const text = JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

const tuningLink = computed(() => {
  const t = r.value.tuning;
  if (!t) return null;
  const lead = { page: 'This finding has its own tuning page', shared: 'This finding shares a tuning page with related findings', section: 'This finding is covered in a section of a tuning page', chapter: 'This finding is covered in a general tuning chapter' }[t.kind];
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

    <!-- The dashboard's own widget for the example finding, in a frame. -->
    <section class="det-section" aria-labelledby="det-example">
      <h2 id="det-example">An example finding</h2>
      <p class="det-small">The dashboard's own widget for this finding, drawn from a run of {{ EXAMPLE_SOURCE_LABEL[r.example.source] }}.</p>
      <iframe
        ref="frame"
        class="det-example"
        :src="exampleFrameSrc(r.type)"
        :style="{ height: `${frameHeight}px` }"
        title="Example finding, as the dashboard shows it"
        loading="lazy"
      ></iframe>
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
              <tr v-for="(value, name) in d.thresholds" :key="name"><td><code>{{ name }}</code></td><td>{{ thresholdText(value) }}</td></tr>
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
.det-label { margin: 14px 0 4px; font-size: 13px; color: var(--sf-muted); }
.det-small { margin: 6px 0 0; font-size: 13px; line-height: 1.5; color: var(--sf-muted); }

.det-example { display: block; width: 100%; max-width: 100%; margin-top: 12px; border: 0; }

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
}
</style>

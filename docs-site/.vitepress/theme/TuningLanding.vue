<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, withBase } from 'vitepress';

const router = useRouter();
const term = ref('');

// Mirrors the upstream landing's known-term routing: a handful of terms and
// config keys resolve to a specific chapter; anything else falls back to the
// config reference (still the most useful landing spot for an unknown key).
const knownTermRoutes: Record<string, string> = {
  memory: 'memory-model',
  'memory-model': 'memory-model',
  spill: 'memory-model',
  'spark.memory.fraction': 'memory-model',
  shuffle: 'shuffle',
  'spark.sql.shuffle.partitions': 'shuffle',
  joins: 'joins',
  join: 'joins',
  'spark.sql.autobroadcastjointhreshold': 'joins',
  aqe: 'aqe',
  'spark.sql.adaptive.enabled': 'aqe',
  config: 'config',
};

function jumpToTopic() {
  const key = term.value.trim().toLowerCase();
  const route = knownTermRoutes[key] || 'config';
  router.go(withBase(`/tuning-reference/${route}`));
}
</script>

<template>
  <main id="main-content" class="tuning-landing">
    <section class="hero" aria-labelledby="page-title">
      <div class="container hero-grid">
        <div class="hero-copy">
          <p class="eyebrow">Practical mechanics, stable references</p>
          <h1 id="page-title">Spark tuning reference</h1>
          <p class="hero-summary">
            Move from a job symptom to the Spark mechanics and settings that can change its
            outcome without treating a tuning guess as evidence.
          </p>
          <div class="hero-actions">
            <a class="button button-primary" :href="withBase('/tuning-reference/intro')"
              >Browse the full reference <span class="arrow" aria-hidden="true">→</span></a
            >
            <a class="button button-secondary" href="#symptoms">Choose a symptom</a>
            <form class="known-term" @submit.prevent="jumpToTopic">
              <label for="known-term-input">Know the term or config key?</label>
              <div class="known-term-row">
                <input
                  id="known-term-input"
                  v-model="term"
                  name="term"
                  type="search"
                  list="known-term-options"
                  placeholder="e.g. spark.sql.shuffle.partitions"
                  autocomplete="off"
                />
                <button class="button button-secondary" type="submit">Jump to topic</button>
              </div>
              <small>Known routes: memory, shuffle, joins, AQE, and config. Other terms open the configuration reference.</small>
              <datalist id="known-term-options">
                <option value="memory"></option>
                <option value="shuffle"></option>
                <option value="joins"></option>
                <option value="AQE"></option>
                <option value="config"></option>
                <option value="spark.memory.fraction"></option>
                <option value="spark.sql.shuffle.partitions"></option>
                <option value="spark.sql.adaptive.enabled"></option>
                <option value="spark.sql.autoBroadcastJoinThreshold"></option>
              </datalist>
            </form>
          </div>
        </div>
        <aside class="signal-board" aria-label="Example symptom paths">
          <div class="board-label">evidence → mechanic → lever</div>
          <ul class="signal-list">
            <li>
              <a class="signal-link" :href="withBase('/tuning-reference/memory-model')"
                ><span class="signal-marker" aria-hidden="true"></span
                ><span class="signal-title">Executor memory pressure</span
                ><span class="signal-destination">#memory-model</span></a
              >
            </li>
            <li>
              <a class="signal-link" :href="withBase('/tuning-reference/shuffle')"
                ><span class="signal-marker" aria-hidden="true"></span
                ><span class="signal-title">Slow, wide stages</span
                ><span class="signal-destination">#shuffle</span></a
              >
            </li>
            <li>
              <a class="signal-link" :href="withBase('/tuning-reference/joins')"
                ><span class="signal-marker" aria-hidden="true"></span
                ><span class="signal-title">Join strategy drift</span
                ><span class="signal-destination">#joins</span></a
              >
            </li>
          </ul>
        </aside>
      </div>
    </section>

    <section class="section" id="symptoms" aria-labelledby="symptoms-title">
      <div class="container">
        <div class="section-heading">
          <h2 id="symptoms-title">Symptoms, mapped to the right lever</h2>
          <p>Each path stays on the canonical reference document, so existing links and saved anchors continue to work.</p>
          <p class="decision-note">
            <strong>How to use this:</strong> SparkForensics reads your Spark event log and
            surfaces evidence; this reference explains the mechanics and settings behind it.
            Diagnose the symptom, change one informed lever, then validate against the next
            run's evidence. Confirm behavior and defaults against your deployed Spark version
            and distribution.
          </p>
        </div>
        <div class="symptom-grid">
          <article class="symptom">
            <div>
              <h3>Spill or GC pressure</h3>
              <p>Trace executor memory, object lifetime, and the trade-offs behind changing memory settings.</p>
            </div>
            <a :href="withBase('/tuning-reference/memory-model')"
              >Open memory model <span aria-hidden="true">→</span></a
            >
          </article>
          <article class="symptom">
            <div>
              <h3>Shuffle-heavy stages</h3>
              <p>Understand write/read costs, partition size, and why moving data becomes the bottleneck.</p>
            </div>
            <a :href="withBase('/tuning-reference/shuffle')"
              >Open shuffle guide <span aria-hidden="true">→</span></a
            >
          </article>
          <article class="symptom">
            <div>
              <h3>Slow or skewed joins</h3>
              <p>Compare join mechanics before changing broadcast thresholds or reshaping a plan.</p>
            </div>
            <a :href="withBase('/tuning-reference/joins')"
              >Open join optimization <span aria-hidden="true">→</span></a
            >
          </article>
          <article class="symptom">
            <div>
              <h3>Plan adapts poorly</h3>
              <p>Use AQE's runtime choices as an inspectable mechanism, not a checkbox to enable blindly.</p>
            </div>
            <a :href="withBase('/tuning-reference/aqe')"
              >Open AQE guide <span aria-hidden="true">→</span></a
            >
          </article>
          <article class="symptom">
            <div>
              <h3>Need the exact setting</h3>
              <p>Check a setting's scope, default, and interaction before applying it to a cluster.</p>
            </div>
            <a :href="withBase('/tuning-reference/config')"
              >Open config reference <span aria-hidden="true">→</span></a
            >
          </article>
        </div>
      </div>
    </section>

    <section class="section workflow" aria-labelledby="workflow-title">
      <div class="container workflow-grid">
        <div class="workflow-copy">
          <h2 id="workflow-title">Let SparkForensics surface the evidence. Use this reference to reason about it.</h2>
          <p>The two tools stay deliberately separate: SparkForensics reads the event log; this static reference explains the mechanics and settings behind what you find.</p>
        </div>
        <ol class="steps">
          <li>
            <span class="step-label">Observe</span>
            <div>
              <strong>Read the stage or executor behavior</strong>
              <span>Start with the event log, metrics, and plan details Spark already produces.</span>
            </div>
          </li>
          <li>
            <span class="step-label">Explain</span>
            <div>
              <strong>Name the mechanism at work</strong>
              <span>Use the stable reference anchors to connect symptoms to memory, shuffle, joins, AQE, or configuration.</span>
            </div>
          </li>
          <li>
            <span class="step-label">Test</span>
            <div>
              <strong>Change one informed lever</strong>
              <span>Make a measured change, then compare the evidence again rather than carrying a tuning superstition forward.</span>
            </div>
          </li>
        </ol>
      </div>
    </section>
  </main>
</template>

<style scoped>
/* Trace world: tokens come from custom.css (--sf-*), which switches with the
   .dark class, so this component needs no theme-specific overrides. */
.tuning-landing {
  --bg: var(--sf-canvas);
  --surface: var(--sf-panel);
  --surface-strong: var(--sf-surface-2);
  --text: var(--sf-ink);
  --muted: var(--sf-muted);
  --line: var(--sf-rule);
  --accent: var(--sf-accent);
  --accent-hover: var(--sf-accent-hover);
  --accent-soft: var(--sf-accent-soft);
  --mono: var(--vp-font-family-mono);

  background: var(--bg);
  font-family: var(--vp-font-family-base);
}

.tuning-landing a { color: inherit; text-decoration: none; }
.tuning-landing button { font: inherit; }
.tuning-landing a:focus-visible,
.tuning-landing button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.container { width: min(100% - 2.5rem, 72rem); margin-inline: auto; }
.mono { font-family: var(--mono); }
/* Trace eyebrow: 11px mono uppercase, muted. */
.eyebrow {
  margin: 0;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.hero { padding: clamp(3.5rem, 8vw, 6rem) 0 clamp(3rem, 6vw, 4.5rem); }
.hero-grid { display: grid; gap: 2.5rem; align-items: center; }
.hero-copy { max-width: 44rem; }
.tuning-landing h1,
.tuning-landing h2,
.tuning-landing h3 { text-wrap: balance; font-stretch: 85%; }
h1 {
  max-width: 14ch;
  margin: .5rem 0 1rem;
  font-size: clamp(2.5rem, 6vw, 4rem);
  font-weight: 600;
  letter-spacing: -.02em;
  line-height: 1.05;
}
.hero-summary { max-width: 40rem; margin: 0; color: var(--muted); font-size: clamp(1.05rem, 2vw, 1.2rem); line-height: 1.55; }
.hero-actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1.75rem; }
.known-term { max-width: 40rem; margin-top: 1.5rem; }
.known-term label { display: block; margin-bottom: .45rem; color: var(--muted); font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; }
.known-term-row { display: flex; flex-wrap: wrap; gap: .5rem; }
.known-term input { min-height: 2.5rem; min-width: min(100%, 19rem); flex: 1 1 14rem; padding: .5rem .7rem; border: 1px solid var(--line); border-radius: var(--sf-radius-button); background: var(--surface); color: var(--text); font: .85rem var(--mono); }
.known-term input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
.known-term small { display: block; margin-top: .5rem; color: var(--muted); font-size: .82rem; }
/* Trace buttons: 4px radius; primary = accent-soft background + accent text. */
.button {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  justify-content: center;
  gap: .5rem;
  padding: .5rem .95rem;
  border: 1px solid var(--line);
  font-family: var(--vp-font-family-base);
  font-size: .9rem;
  font-weight: 500;
  border-radius: var(--sf-radius-button);
  cursor: pointer;
}
.button-primary { border-color: transparent; background: var(--accent-soft); color: var(--accent); }
.tuning-landing a.button-primary { color: var(--accent); }
.button-primary:hover { background: color-mix(in srgb, var(--accent) 20%, var(--surface)); }
.tuning-landing a.button-primary:hover { color: var(--accent-hover); }
.button-secondary { background: var(--surface); color: var(--text); }
.button-secondary:hover { background: var(--bg); border-color: color-mix(in srgb, var(--muted) 45%, var(--line)); }
.arrow { font-size: 1.05em; }

/* Example paths as a panel of rule-separated rows (mockup findings rows). */
.signal-board {
  display: grid;
  gap: 0;
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: var(--sf-radius-panel);
  overflow: hidden;
}
.board-label { padding: .75rem 1rem; border-bottom: 1px solid var(--line); color: var(--muted); font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; }
.signal-list { display: grid; margin: 0; padding: 0; list-style: none; }
.signal-list li { border-bottom: 1px solid var(--line); }
.signal-list li:last-child { border: 0; }
.signal-link { display: grid; grid-template-columns: auto 1fr auto; gap: .75rem; align-items: center; padding: .85rem 1rem; }
.signal-link:hover { background: var(--surface-strong); }
.signal-link:hover .signal-title { color: var(--accent); }
/* Neutral markers: these are reading paths, not analysis status. */
.signal-marker { width: .5rem; height: .5rem; border-radius: 2px; background: var(--accent); }
.signal-title { font-weight: 600; }
.signal-destination { color: var(--muted); font-family: var(--mono); font-size: .75rem; }

.section { padding: clamp(3rem, 7vw, 5rem) 0; }
.section-heading { max-width: 44rem; margin-bottom: 2rem; }
.section-heading h2 { margin: 0 0 .75rem; font-size: clamp(1.75rem, 3.5vw, 2.5rem); font-weight: 600; letter-spacing: -.02em; line-height: 1.1; }
.section-heading p { margin: 0; color: var(--muted); font-size: 1.02rem; }
.decision-note { max-width: 52rem; margin: -1rem 0 2rem; padding: .75rem 1rem; border-left: 3px solid var(--accent); background: var(--surface); color: var(--muted); border-radius: 0 var(--sf-radius-panel) var(--sf-radius-panel) 0; }
.decision-note strong { color: var(--text); }
/* Symptom cards: separate panels on the canvas, like the board's widgets. */
.symptom-grid { display: grid; gap: 1rem; }
.symptom { display: flex; min-height: 11rem; flex-direction: column; justify-content: space-between; padding: 1rem 1.1rem; border: 1px solid var(--line); border-radius: var(--sf-radius-panel); background: var(--surface); transition: border-color .15s; }
.symptom:hover { border-color: var(--accent); }
.symptom h3 { margin: 0 0 .4rem; font-size: 1.05rem; font-weight: 600; letter-spacing: -.01em; }
.symptom p { margin: 0; color: var(--muted); font-size: .9rem; line-height: 1.5; }
.symptom a { display: inline-flex; gap: .3rem; width: fit-content; margin-top: 1.1rem; color: var(--accent); font-family: var(--mono); font-size: 12px; font-weight: 500; }
.symptom a:hover { color: var(--accent-hover); text-decoration: underline; text-underline-offset: 3px; }

.workflow { background: var(--surface); border-block: 1px solid var(--line); }
.workflow-grid { display: grid; gap: 2rem; }
.workflow-copy { max-width: 32rem; }
.workflow-copy h2 { margin: 0 0 .9rem; font-size: clamp(1.75rem, 3.5vw, 2.5rem); font-weight: 600; letter-spacing: -.02em; line-height: 1.1; }
.workflow-copy p { color: var(--muted); }
.steps { display: grid; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line); }
.steps li { display: grid; grid-template-columns: 5.5rem 1fr; gap: 1rem; padding: .9rem 0; border-bottom: 1px solid var(--line); }
.step-label { color: var(--accent); font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; padding-top: .2rem; }
.steps strong { display: block; margin-bottom: .15rem; font-weight: 600; }
.steps span:not(.step-label) { color: var(--muted); font-size: .92rem; }

@media (min-width: 46rem) {
  .hero-grid { grid-template-columns: minmax(0, 1.25fr) minmax(19rem, .75fr); }
  .symptom-grid { grid-template-columns: repeat(2, 1fr); }
  .workflow-grid { grid-template-columns: minmax(0, .88fr) minmax(24rem, 1.12fr); align-items: center; }
}
@media (min-width: 70rem) { .symptom-grid { grid-template-columns: repeat(5, 1fr); } }
@media (max-width: 34rem) {
  .container { width: min(100% - 2rem, 72rem); }
  h1 { font-size: clamp(2.25rem, 11vw, 3rem); }
  .signal-destination { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .tuning-landing * {
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
  }
}
</style>

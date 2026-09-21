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
.tuning-landing {
  --teal: #39d6b5;
  --teal-soft: rgba(57, 214, 181, 0.13);
  --orange-soft: rgba(255, 107, 44, 0.13);
  --on-orange: #17110e;

  --bg: var(--vp-c-bg);
  --surface: var(--vp-c-bg-soft);
  --surface-strong: var(--vp-c-bg-elv);
  --text: var(--vp-c-text-1);
  --muted: var(--vp-c-text-2);
  --line: var(--vp-c-divider);
  --orange: var(--vp-c-brand-1);
  --orange-hover: var(--vp-c-brand-2);
  --radius: var(--vp-radius-lg);
  --shadow-soft: 0 1.5rem 3rem -1rem rgba(0, 0, 0, 0.45);
  --mono: var(--vp-font-family-mono);

  font-family: var(--vp-font-family-base);
}

.dark .tuning-landing,
:root.dark .tuning-landing {
  --on-orange: #17110e;
  --shadow-soft: 0 1.5rem 3rem -1rem rgba(0, 0, 0, 0.45);
}

:root:not(.dark) .tuning-landing {
  --teal: #007e6b;
  --teal-soft: rgba(0, 126, 107, 0.13);
  --on-orange: #ffffff;
  --shadow-soft: 0 1.5rem 3rem -1rem rgba(21, 27, 30, 0.16);
}

.tuning-landing a { color: inherit; text-decoration: none; }
.tuning-landing button { font: inherit; }
.tuning-landing a:focus-visible,
.tuning-landing button:focus-visible {
  outline: 3px solid var(--teal);
  outline-offset: 3px;
}
.container { width: min(100% - 2.5rem, 72rem); margin-inline: auto; }
.mono { font-family: var(--mono); }
.eyebrow {
  margin: 0;
  color: var(--teal);
  font-family: var(--mono);
  font-size: .76rem;
  font-weight: 700;
  letter-spacing: .075em;
  text-transform: uppercase;
}

.hero { padding: clamp(4.5rem, 10vw, 8rem) 0 clamp(4rem, 8vw, 6.5rem); }
.hero-grid { display: grid; gap: 3rem; align-items: center; }
.hero-copy { max-width: 44rem; }
.tuning-landing h1,
.tuning-landing h2,
.tuning-landing h3 { text-wrap: balance; }
h1 {
  max-width: 11ch;
  margin: .65rem 0 1.15rem;
  font-size: clamp(3.15rem, 8vw, 6.75rem);
  font-weight: 850;
  letter-spacing: -.03em;
  line-height: .9;
}
.hero-summary { max-width: 40rem; margin: 0; color: var(--muted); font-size: clamp(1.08rem, 2.1vw, 1.3rem); }
.hero-actions { display: flex; flex-wrap: wrap; gap: .8rem; margin-top: 2rem; }
.known-term { max-width: 40rem; margin-top: 1.5rem; }
.known-term label { display: block; margin-bottom: .45rem; color: var(--text); font-family: var(--mono); font-size: .82rem; font-weight: 700; }
.known-term-row { display: flex; flex-wrap: wrap; gap: .55rem; }
.known-term input { min-height: 3rem; min-width: min(100%, 19rem); flex: 1 1 14rem; padding: .65rem .75rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); color: var(--text); font: .88rem var(--mono); }
.known-term input:focus-visible { outline: 3px solid var(--teal); outline-offset: 2px; border-color: var(--teal); }
.known-term small { display: block; margin-top: .5rem; color: var(--muted); font-size: .82rem; }
.button {
  display: inline-flex;
  min-height: 3rem;
  align-items: center;
  justify-content: center;
  gap: .6rem;
  padding: .65rem 1.05rem;
  border: 1px solid var(--line);
  font-family: var(--mono);
  font-size: .88rem;
  font-weight: 700;
  border-radius: var(--radius);
}
.button-primary { border-color: var(--orange); background: var(--orange); color: var(--on-orange); }
.tuning-landing a.button-primary { color: var(--on-orange); }
.button-primary:hover { background: var(--orange-hover); border-color: var(--orange-hover); }
.button-secondary { background: transparent; color: var(--text); }
.button-secondary:hover { border-color: var(--teal); color: var(--teal); }
.arrow { font-size: 1.1em; }

.signal-board {
  display: grid;
  gap: 0;
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-soft);
  border-radius: var(--radius);
  overflow: hidden;
}
.board-label { padding: .8rem 1rem; border-bottom: 1px solid var(--line); color: var(--muted); font-family: var(--mono); font-size: .74rem; }
.signal-list { display: grid; margin: 0; padding: 0; list-style: none; }
.signal-list li { border-bottom: 1px solid var(--line); }
.signal-list li:last-child { border: 0; }
.signal-link { display: grid; grid-template-columns: auto 1fr auto; gap: .75rem; align-items: center; padding: .95rem 1rem; }
.signal-link:hover { background: var(--surface-strong); }
.signal-marker { width: .6rem; height: .6rem; border-radius: 9999px; background: var(--teal); box-shadow: 0 0 0 .22rem var(--teal-soft); }
.signal-list li:nth-child(2) .signal-marker { background: var(--orange); box-shadow: 0 0 0 .22rem var(--orange-soft); }
.signal-title { font-weight: 750; }
.signal-destination { color: var(--muted); font-family: var(--mono); font-size: .75rem; }

.section { padding: clamp(4rem, 8vw, 6.5rem) 0; }
.section-heading { max-width: 44rem; margin-bottom: 2rem; }
.section-heading h2 { margin: 0 0 .8rem; font-size: clamp(2rem, 4vw, 3.25rem); letter-spacing: -.03em; line-height: 1.04; }
.section-heading p { margin: 0; color: var(--muted); font-size: 1.05rem; }
.decision-note { max-width: 52rem; margin: -1rem 0 2rem; padding: 1rem 1.1rem; border: 1px solid var(--line); background: var(--surface); color: var(--muted); border-radius: var(--radius); }
.decision-note strong { color: var(--text); }
.symptom-grid { display: grid; border-top: 1px solid var(--line); border-left: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.symptom { display: flex; min-height: 12.5rem; flex-direction: column; justify-content: space-between; padding: 1.25rem; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--bg); }
.symptom:hover { background: var(--surface); }
.symptom h3 { margin: 0 0 .45rem; font-size: 1.2rem; letter-spacing: -.025em; }
.symptom p { margin: 0; color: var(--muted); font-size: .94rem; }
.symptom a { display: inline-flex; width: fit-content; margin-top: 1.25rem; color: var(--teal); font-family: var(--mono); font-size: .82rem; font-weight: 700; }
.symptom a:hover { color: var(--orange); }

.workflow { background: var(--surface); border-block: 1px solid var(--line); }
.workflow-grid { display: grid; gap: 2rem; }
.workflow-copy { max-width: 32rem; }
.workflow-copy h2 { margin: 0 0 .9rem; font-size: clamp(2rem, 4vw, 3.25rem); letter-spacing: -.03em; line-height: 1.04; }
.workflow-copy p { color: var(--muted); }
.steps { display: grid; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line); }
.steps li { display: grid; grid-template-columns: 5.5rem 1fr; gap: 1rem; padding: 1rem 0; border-bottom: 1px solid var(--line); }
.step-label { color: var(--orange); font-family: var(--mono); font-size: .72rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.steps strong { display: block; margin-bottom: .15rem; }
.steps span:not(.step-label) { color: var(--muted); font-size: .93rem; }

@media (min-width: 46rem) {
  .hero-grid { grid-template-columns: minmax(0, 1.25fr) minmax(19rem, .75fr); }
  .symptom-grid { grid-template-columns: repeat(2, 1fr); }
  .workflow-grid { grid-template-columns: minmax(0, .88fr) minmax(24rem, 1.12fr); align-items: center; }
}
@media (min-width: 70rem) { .symptom-grid { grid-template-columns: repeat(5, 1fr); } }
@media (max-width: 34rem) {
  .container { width: min(100% - 1.5rem, 72rem); }
  h1 { font-size: clamp(2.85rem, 16vw, 4.25rem); }
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

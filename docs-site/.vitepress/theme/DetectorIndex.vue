<script setup lang="ts">
import data from '../detectors-data.json';
import { FIX_EFFORT_LABEL, SCOPE_LABEL, sentenceCase, siteHref, type DetectorData } from './detectors';

const { families, records } = data as unknown as DetectorData;
const groups = families
  .map((family) => ({ ...family, records: records.filter((r) => r.family === family.id) }))
  .filter((group) => group.records.length > 0);
</script>

<template>
  <main id="main-content" class="det-index">
    <header class="det-hero">
      <p class="det-eyebrow">Detector catalog</p>
      <h1>What SparkForensics checks in a Spark run</h1>
      <p class="det-standfirst">
        {{ records.length }} checks, grouped by what they cost you: run time, money, failed work,
        SQL plans and setup. Each page says what the finding means, where you see it in the
        dashboard, an agent, CI and Airflow, and the thresholds behind it.
      </p>
    </header>

    <section v-for="group in groups" :key="group.id" :id="group.id" class="det-group" :aria-labelledby="`${group.id}-title`">
      <h2 :id="`${group.id}-title`">{{ group.label }} <span class="det-count">{{ group.records.length }}</span></h2>
      <ul class="det-cards">
        <li v-for="r in group.records" :key="r.type" class="det-card">
          <a class="det-card-link" :href="siteHref(r.pages.catalog)">
            <span class="det-card-head">
              <span class="sf-chip">{{ r.tag }}</span>
              <span class="det-card-name">{{ sentenceCase(r.name) }}</span>
            </span>
            <span class="det-card-pitch">{{ r.pitch }}</span>
            <span class="det-pills">
              <span class="sf-pill">{{ SCOPE_LABEL[r.scope] }}</span>
              <span class="sf-pill">{{ FIX_EFFORT_LABEL[r.fixEffort] }}</span>
              <span v-if="r.region === 'reference'" class="sf-pill">reference</span>
              <span v-if="r.gate" class="sf-pill">budget flag</span>
            </span>
          </a>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.det-index { max-width: 1040px; margin: 0 auto; padding: 8px 0 48px; }
.det-hero { margin-bottom: 28px; }
.det-eyebrow {
  margin: 0 0 6px; font-family: var(--vp-font-family-mono); font-size: 12px;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--sf-muted);
}
.det-hero h1 { margin: 0 0 12px; font-size: 32px; line-height: 1.2; letter-spacing: -0.01em; }
.det-standfirst { margin: 0; max-width: 62ch; font-size: 17px; line-height: 1.55; color: var(--sf-muted); }
.det-group { margin-top: 36px; }
.det-group h2 {
  margin: 0 0 14px; padding-top: 0; border-top: 0; font-size: 20px; display: flex; align-items: center; gap: 10px;
}
.det-count { font-family: var(--vp-font-family-mono); font-size: 12px; font-weight: 500; color: var(--sf-muted); }
.det-cards {
  list-style: none; margin: 0; padding: 0;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;
}
.det-cards li { margin: 0; }
.det-card { background: var(--sf-panel); border: 1px solid var(--sf-rule); border-radius: 6px; }
.det-card:hover { border-color: var(--sf-accent); }
.det-card-link {
  display: flex; flex-direction: column; gap: 8px; height: 100%; box-sizing: border-box;
  padding: 14px 16px; color: inherit; text-decoration: none;
}
.det-card-head { display: flex; align-items: center; gap: 10px; }
.det-card-name { font-weight: 600; font-size: 15px; color: var(--sf-ink); }
.det-card-pitch { font-size: 14px; line-height: 1.5; color: var(--sf-muted); flex: 1; }
.det-pills { display: flex; flex-wrap: wrap; gap: 6px; }
@media (max-width: 640px) {
  .det-hero h1 { font-size: 26px; }
  .det-cards { grid-template-columns: 1fr; }
}
</style>

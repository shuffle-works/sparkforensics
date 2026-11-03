<script setup lang="ts">
import data from '../detectors-data.json';
import { selectRecords, siteHref, type DetectorData, type DetectorRecord } from './detectors';

const props = defineProps<{ family?: string; region?: DetectorRecord['region'] }>();
const records = selectRecords((data as unknown as DetectorData).records, props);

/** `key = value` pairs of one detector entry; a detector with no thresholds shows "none". */
function formatThresholds(thresholds: Record<string, unknown>): string[] {
  return Object.entries(thresholds).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
}
</script>

<template>
  <table>
    <thead>
      <tr><th>Finding type</th><th>Fires when</th><th>Default thresholds</th></tr>
    </thead>
    <tbody>
      <tr v-for="r in records" :key="r.type">
        <td><a :href="siteHref(r.pages.catalog)"><code>{{ r.type }}</code></a></td>
        <td>{{ r.thresholdSummary }}</td>
        <td>
          <div v-for="d in r.detectors" :key="d.detector + d.version" class="det-entry">
            <span v-if="r.detectors.length > 1 || d.detector !== r.type" class="det-entry-name">
              <code>{{ d.detector }}</code> v{{ d.version }}
            </span>
            <code v-for="pair in formatThresholds(d.thresholds)" :key="pair" class="det-threshold">{{ pair }}</code>
            <span v-if="!Object.keys(d.thresholds).length">none</span>
          </div>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
td:nth-child(2) { min-width: 14rem; }
.det-entry + .det-entry { margin-top: 8px; }
.det-entry-name, .det-threshold { display: block; }
.det-threshold { width: fit-content; max-width: 100%; margin: 0 0 4px; overflow-wrap: anywhere; }
</style>

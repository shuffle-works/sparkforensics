<script setup lang="ts">
import data from '../detectors-data.json';
import { selectRecords, siteHref, type DetectorData, type DetectorRecord } from './detectors';

const props = defineProps<{ family?: string; region?: DetectorRecord['region'] }>();
const records = selectRecords((data as unknown as DetectorData).records, props);
</script>

<template>
  <ul class="det-type-list">
    <li v-for="r in records" :key="r.type">
      <a :href="siteHref(r.pages.catalog)"><code>{{ r.type }}</code></a>
      (<code>{{ r.tag }}</code>, {{ r.name }})
    </li>
  </ul>
</template>

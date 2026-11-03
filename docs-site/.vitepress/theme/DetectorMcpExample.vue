<script setup lang="ts">
import data from '../detectors-data.json';
import type { DetectorData } from './detectors';

const props = defineProps<{ type: string }>();
const record = (data as unknown as DetectorData).records.find((r) => r.type === props.type);
if (!record) throw new Error(`DetectorMcpExample: no detector type "${props.type}" in the catalog`);
const { listCall, listResponse } = record.surfaces.mcp;
</script>

<template>
  <p>Example call:</p>
  <div class="language-json"><pre><code>{{ JSON.stringify(listCall, null, 2) }}</code></pre></div>
  <p>Example response:</p>
  <div class="language-json"><pre><code>{{ JSON.stringify(listResponse, null, 2) }}</code></pre></div>
</template>

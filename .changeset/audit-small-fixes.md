---
"sparkforensics-web": patch
---

Six dashboard and test fixes. A route to a finding lands on its own row after a switch to another run, because rows register under the core finding key. The core-usage histogram loads for each run. The Scorecard cold-start note ignores the finding filter. Pinned stage deltas leave volume and count metrics neutral. The partition hint appears only when the finding says `spark.sql.shuffle.partitions` sized the stage. Corpus-backed tests fail in CI when the corpus is missing instead of skipping.

# sparkforensics-analyze

## 0.13.0

### Patch Changes

- 9076304: Budgets now report failed jobs. `evaluate_budgets` and the CLI add an always-on `no-failed-jobs` result: a run with one or more failed jobs is a violation that names the count and the failed job ids, and a run with none passes. **The CLI now exits 1 for a run with a failed job, with or without budget flags**, where it passed or exited 3 before. Every budget result list gains a `no-failed-jobs` row, and the JSON envelope schema accepts the new name. `maxFailedTaskRatePct` is unchanged.
- a635c00: Run comparison no longer counts `spark.app.initial.jar.urls`, `spark.driver.appUIAddress` and the AmIpFilter `PROXY_URI_BASES` key as configuration differences. Two runs of the same job can now reach the "same configuration and plan" verdict.
- 399095d: The run comparison verdict states a change in input or output volume with the same figures the Comparability section prints. It names introduced and resolved findings by category and impact band instead of netting counts per category, so a resolved critical finding stays visible. A `low` confidence comparison gets a one-sentence verdict that gives the reason. Output rows now use the noise band like the byte figures, so a small row-count change no longer marks the output as different.
- 95bd273: The `LOCAL` band follows the modeled fetch cost as a share of run task time, so a high non-local ratio on a cheap run is no longer critical. Impact figures print in one unit per category (GB-h for memory, core-h for core time) whatever their size. Every finding row, in the CLI JSON report and in both MCP views, gains `rankImpactMs`, a millisecond ranking figure on the axis of `rankCostMs`, for ranking findings by impact.
- 81a3862: `get_finding_documentation` and `get_reference_doc` list the valid values when given an unknown type or anchor (a long type list is capped, with the count of the rest and a pointer to `list_detectors`; the anchor list is complete). The ETL phase buckets in `runShape.etlPhasesMs` are now the union of their stages' intervals, so concurrent stages count once and no bucket exceeds wall-clock. The `get_run_summary` description explains how stages are assigned to phases and what a zero bucket means.
- 023cb51: Relicense under FSL-1.1-MIT.
- 39eff4f: `retryWaste` evidence tells an executor lost to the cluster from one lost to the application. The parser keeps `Exit Caused By App`, the flag Spark uses to decide whether a lost task counts toward `spark.task.maxFailures`. Each sampled attempt carries `lossReason` and `exitCausedByApp`, and the new `executorLosses` evidence groups the losses by executor and cause. When every retried attempt is a loss with `exitCausedByApp: false`, the recommendation says the executor exits were unrelated to the running tasks (for example preemption, node loss, or a container the resource manager or driver released) and do not count toward `spark.task.maxFailures`, and it gives no application fix. When only some are, it keeps the application advice and adds a caveat. `executorLosses` lists the first 50 groups seen per stage.
- 0348ca9: The slow-host (`HOST`) detector compares input and shuffle bytes per task instead of per executor total, so executors that lived for different spans of a stage (dynamic allocation, executor loss) no longer flag each other. Executor findings on every dimension stay at `info` and carry `medianValue` and `executorCount` in their evidence. Their byte-dimension text says the figure is per task and names larger partitions (data skew), not a degraded executor, as the cause. Input and shuffle bytes now pass the same chance test as task time, so a short-lived executor whose few tasks were large is not flagged. Each `executorStats` row of a stage record carries four new additive fields, `logInputBytesSum`, `logInputBytesM2`, `logShuffleBytesSum` and `logShuffleBytesM2`; a stage recorded without them flags no executor on that byte dimension.
- Updated dependencies [9076304]
- Updated dependencies [a635c00]
- Updated dependencies [399095d]
- Updated dependencies [95bd273]
- Updated dependencies [81a3862]
- Updated dependencies [023cb51]
- Updated dependencies [39eff4f]
- Updated dependencies [67e9fb9]
- Updated dependencies [0348ca9]
  - sparkforensics-cli@0.13.0

## 0.12.1

### Patch Changes

- Updated dependencies [f572d91]
- Updated dependencies [830caf5]
- Updated dependencies [797d6f2]
- Updated dependencies [c1b8b57]
  - sparkforensics-cli@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [2551d06]
- Updated dependencies [b519d1d]
- Updated dependencies [116e698]
- Updated dependencies [bd7499c]
- Updated dependencies [be0eb32]
- Updated dependencies [9efb086]
- Updated dependencies [8ecc03a]
- Updated dependencies [32f661d]
- Updated dependencies [7d2f0ec]
- Updated dependencies [3ef528e]
- Updated dependencies [07a8caa]
- Updated dependencies [175b70d]
- Updated dependencies [1ebb276]
- Updated dependencies [901d314]
- Updated dependencies [b519d1d]
- Updated dependencies [d1940d5]
- Updated dependencies [07a8caa]
- Updated dependencies [41eca63]
- Updated dependencies [a0312b6]
- Updated dependencies [bede8a6]
- Updated dependencies [fda4639]
- Updated dependencies [3ef528e]
- Updated dependencies [069cb67]
- Updated dependencies [912e726]
- Updated dependencies [a27f6fb]
  - sparkforensics-cli@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [2b620fe]
- Updated dependencies [cf91d4d]
- Updated dependencies [5105a8c]
- Updated dependencies [3cfa7ce]
- Updated dependencies [ce35800]
- Updated dependencies [4a73be8]
- Updated dependencies [a333977]
- Updated dependencies [7a27c54]
- Updated dependencies [959e02b]
- Updated dependencies [f3359b8]
- Updated dependencies [d9d4dde]
- Updated dependencies [5105a8c]
- Updated dependencies [3a407c0]
- Updated dependencies [5a774d9]
- Updated dependencies [3497f4e]
- Updated dependencies [121f02e]
- Updated dependencies [dcb95f7]
- Updated dependencies [223a50c]
- Updated dependencies [0c34405]
- Updated dependencies [84eba1d]
- Updated dependencies [0c824f0]
  - sparkforensics-cli@0.11.0

## 0.10.1

### Patch Changes

- Updated dependencies [173d54d]
- Updated dependencies [531fd1a]
- Updated dependencies [9920857]
  - sparkforensics-cli@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [7ea5b70]
- Updated dependencies [8f7f6d0]
- Updated dependencies [1c9c274]
- Updated dependencies [dcc243d]
- Updated dependencies [a275a49]
- Updated dependencies [5d085d5]
- Updated dependencies [052cce9]
- Updated dependencies [ceda2e8]
- Updated dependencies [a92a85a]
- Updated dependencies [79c4d97]
- Updated dependencies [7379bdd]
- Updated dependencies [0ea9fbd]
- Updated dependencies [1ed4c88]
- Updated dependencies [db16093]
- Updated dependencies [ab28fcc]
- Updated dependencies [6d0e89d]
- Updated dependencies [ab28fcc]
- Updated dependencies [7e3789d]
- Updated dependencies [9d62522]
- Updated dependencies [eed36cf]
- Updated dependencies [4e3e32b]
- Updated dependencies [54f859b]
- Updated dependencies [aa04e41]
  - sparkforensics-cli@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [43a5e93]
- Updated dependencies [9b80793]
- Updated dependencies [73b5807]
  - sparkforensics-cli@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [11e116a]
- Updated dependencies [b3e3520]
- Updated dependencies [3f1e7bd]
- Updated dependencies [ccfae9e]
  - sparkforensics-cli@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [2a7acea]
- Updated dependencies [7db426c]
- Updated dependencies [e740c9a]
  - sparkforensics-cli@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [ad67597]
- Updated dependencies [2d2e51b]
- Updated dependencies [67aecba]
  - sparkforensics-cli@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [856de0b]
- Updated dependencies [18ca1d5]
- Updated dependencies [e932665]
- Updated dependencies [2653ccb]
- Updated dependencies [ac5300f]
- Updated dependencies [8b7a648]
- Updated dependencies [82a9052]
- Updated dependencies [8d4a529]
- Updated dependencies [c5f5663]
- Updated dependencies [7fe40c7]
- Updated dependencies [ea6e2a4]
- Updated dependencies [d3a74d7]
- Updated dependencies [ef79364]
  - sparkforensics-cli@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [8ad8560]
- Updated dependencies [d7ea65a]
- Updated dependencies [4538c3e]
- Updated dependencies [d7ea65a]
- Updated dependencies [e6f01b9]
- Updated dependencies [e6f01b9]
- Updated dependencies [4feed5e]
- Updated dependencies [6b3c2ba]
- Updated dependencies [3fbd34b]
- Updated dependencies [98591c4]
- Updated dependencies [98591c4]
- Updated dependencies [98591c4]
- Updated dependencies [98591c4]
- Updated dependencies [98591c4]
- Updated dependencies [98591c4]
- Updated dependencies [6a8f927]
- Updated dependencies [e6f01b9]
- Updated dependencies [e6f01b9]
  - sparkforensics-cli@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8891e15]
- Updated dependencies [13b3ccb]
- Updated dependencies [9a68eae]
- Updated dependencies [daf8d62]
- Updated dependencies [6b09caf]
  - sparkforensics-cli@0.3.0

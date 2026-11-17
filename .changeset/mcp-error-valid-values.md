---
"sparkforensics-analyze": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
"sparkforensics": patch
---

`get_finding_documentation` and `get_reference_doc` list the valid values when given an unknown type or anchor (a long type list is capped, with the count of the rest and a pointer to `list_detectors`; the anchor list is complete). The ETL phase buckets in `runShape.etlPhasesMs` are now the union of their stages' intervals, so concurrent stages count once and no bucket exceeds wall-clock. The `get_run_summary` description explains how stages are assigned to phases and what a zero bucket means.

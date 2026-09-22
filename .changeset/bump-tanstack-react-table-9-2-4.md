---
"sparkforensics": patch
---

Bump @tanstack/react-table from 8.21.3 to 9.2.4. Migrates `StageTable`'s `useReactTable` call to v9's explicit `tableFeatures`/`useTable` API (row sorting, row pagination, and column visibility, the last needed for `row.getVisibleCells()`); no behavior change.

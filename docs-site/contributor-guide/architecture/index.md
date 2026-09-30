# Architecture

These pages cover one concern each: the two-actor overview, the worker
protocol, state plus History Server intake, the detector contract, impact
estimation, the fixed widget rendering order, the board's widgets, and the
stage and plan drill-downs.

Where to start:

- [Two actors](./overview.md#two-actors): the parser worker and the view, and why
  the split exists.
- [Detector contract](./detector-contract.md#detector-contract): the interface
  every bottleneck detector implements. Read this before adding a finding.
- [Impact estimation](./impact-estimation.md#impact-estimation): how findings get
  a wall-clock/resource waste estimate attached.
- [Testing layout](../testing.md#testing-layout): where tests live and what each
  layer covers.
- [Contributing](../contributing.md): where new docs go, changesets and the
  release flow.

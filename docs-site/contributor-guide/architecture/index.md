# Architecture

Each page covers one concern, and the larger ones split into child pages
that the sidebar nests beneath them. Start with the two-actor overview, then
the worker protocol, state and History Server intake, the detector contract,
impact estimation, widget rendering, the board's widgets and the drill-downs.

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

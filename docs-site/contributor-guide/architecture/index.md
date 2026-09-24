# Architecture

These pages cover one concern each: the worker protocol, the state model, the
detector contract, and the fixed widget rendering order.

Where to start:

- [Two actors](./overview.md#two-actors): the parser worker and the view, and why
  the split exists.
- [Detector contract](./detector-contract.md#detector-contract): the interface
  every bottleneck detector implements. Read this before adding a finding.
- [Impact estimation](./impact-estimation.md#impact-estimation): how findings get
  a wall-clock/resource waste estimate attached.
- [Testing layout](../testing.md#testing-layout): where tests live and what each
  layer covers.
- [Contributing](../contributing.md): how architectural decisions get recorded as
  ADRs.

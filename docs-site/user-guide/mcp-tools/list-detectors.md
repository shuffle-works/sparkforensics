# `list_detectors`

Reference for the `list_detectors` tool of the SparkForensics MCP server.

Every finding type the detectors can report, independent of any run: what it
finds, how it is grouped, its default thresholds, where its docs live and
the budget flag that gates it. An agent can call it to learn what
SparkForensics checks before it loads a run. The same list is on the command
line as [`sparkforensics-analyze detectors`](../getting-started/ci-and-automation.md#list-the-detectors)
and as the [detector catalog](../../detectors/index.md) pages of this site.

Parameter, optional:

- `type`: one finding `type` value, such as `"skew"`. An unknown type fails
  input validation. Without it the tool returns every type.

Example call:

```json
{ "name": "list_detectors", "arguments": { "type": "skew" } }
```

Example response:

```json
{
  "count": 1,
  "detectors": [
    {
      "type": "skew",
      "name": "task skew",
      "tag": "SKEW",
      "tagSharedWith": [],
      "family": "speed",
      "pitch": "One slow task holds a whole stage back while the rest of the cluster waits.",
      "region": "action",
      "scope": "stage",
      "fixEffort": "code",
      "thresholdSummary": "P95 task time over 3× the median (the longest task on stages under 20 tasks), and the slow tasks read correspondingly more data",
      "detectors": [
        {
          "detector": "skew",
          "version": 1,
          "thresholds": {
            "ratioWarn": 3,
            "minTasksForP95": 20,
            "dataShareMin": 0.5,
            "floorPctWarn": 0.005
          }
        }
      ],
      "pages": {
        "catalog": "docs/detectors/skew.html",
        "guide": "docs/user-guide/understanding-findings.html#skew"
      },
      "tuning": {
        "kind": "page",
        "anchor": "#bottleneck-skew",
        "path": "docs/tuning-reference/bottleneck-skew.html#bottleneck-skew"
      },
      "gate": {
        "cliFlag": "--max-skew",
        "airflowParam": "max_skew_ratio"
      }
    }
  ]
}
```

Each record has:

- `type`, `name`, `tag` and `tagSharedWith`, the other types that share the tag.
- `family` and `pitch`: the outcome group and one sentence on what the finding means.
- `region`: `"reference"` for the types the dashboard shows below its action widgets, `"action"` for the rest.
- `scope` and `fixEffort`: where the detector looks, and whether the fix is a setting (`config`) or a change to the job (`code`).
- `thresholdSummary` and `detectors`: the clean-check criterion, and one entry per detector that emits the type with its version and default thresholds. A type can have several entries (`configAudit` has three). A server started with `--thresholds` still lists the defaults here; its analyzing tools report the tuned values.
- `pages`: the catalog page of the type and its entry in the findings guide, as paths under the site root.
- `tuning`: where the tuning reference covers the type, as a `page` of its own, a `section` of another page or a general `chapter`. It is `null` when no single anchor covers the type.
- `gate`: the CLI budget flag and the Airflow operator parameter that gate the type directly. It is `null` for the types with no budget; those are gated with `--fail-on-introduced` against a baseline.

For the detection and tuning text of one type, call
[`get_finding_documentation`](./get-finding-documentation.md).

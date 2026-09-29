---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

Findings, clean checks and the Advanced verdict say each fact once and give real numbers.

- A cache finding names its RDD by the first 40 characters of the name, which is often a whole physical plan, and an unnamed RDD reads "RDD 7" instead of "RDD RDD 7". The Cache Storage card still shows the full name.
- A Findings group of resource findings shows its total, such as "×2 · 2.6 GB-h", instead of "resource-cost projection", the total the CLI report already printed. A group of findings in one band shows "×2" instead of "2 info" under the Info heading. Task skew's and shuffle's fixes no longer end by restating their row label.
- Clean-check captions state the detector's thresholds, such as "Stage shuffle read above 50 MiB." instead of "the configured minimum byte threshold", and a run tuned with `--thresholds` states its tuned numbers. The intro reads "Every check below passed. Each caption gives the threshold it was held to."
- The Advanced verdict's estimate line no longer repeats the savings range beside it ("Estimate: Measured; the stage shared the cluster: 411ms is the floor, 1.3s if the fix fully lands."), and the order note reads "Order: highest potential savings first, unestimated last; impact band breaks ties."
- Confidence caveats say what their floor means, such as "Warning needs at least 0.5% of run time at stake, critical 2%." for stragglers, instead of "our own noise floor for this metric". Skew, GC, core locality and duplicate plan subtree caveats change the same way.
- The Incomplete Run card states the missing ApplicationEnd event once, in a shorter sentence, and a verdict led by idle capacity drops its summary sentence, since the title gives the idle share and the first step the fix.

The CLI report and MCP tools carry the same recommendation, caveat, threshold and estimate text.

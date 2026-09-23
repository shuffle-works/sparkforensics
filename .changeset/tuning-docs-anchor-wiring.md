---
"sparkforensics": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Finding docs links now open the section written for each finding: partition sizing, speculation
waste, core locality, caching opportunity, cache utilization and autoscaling churn (which had no
docs link before) each link to their own tuning-reference section instead of a shared parent
page. Config audit tags link to the audited property's section when the tag stands for one
property, instead of skipping the tuning reference. `get_finding_documentation` returns the owning
chapter for autoscaling churn and cache utilization, whose sections live on a general chapter,
instead of `tuningDoc: null`.

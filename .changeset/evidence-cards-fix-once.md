---
"sparkforensics-web": patch
---

Evidence cards state each fix once. GC Pressure, Stragglers, Slow Executor Host, Spill, Executor Utilization, Failed Stages, Cold Start, Cache Storage, Caching Opportunities and Redundant Plan Subtree print the fix at the top of the card, one line per kind of finding it holds, and each row keeps only its measurement. Before, every row repeated its detector's recommendation, which restates the row's number and then gives the same fix as the row above. Core Usage by Locality follows its non-local share with the fix instead of the recommendation that restated the share. Cache Storage shows each finding's measured detail in Basic view too, and Caching Opportunities' Recommendation column becomes Estimate.

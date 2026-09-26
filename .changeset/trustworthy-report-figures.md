---
"sparkforensics-web": patch
---

Full app report figures now say what they measure. Stage Summary's "Flagged" column, which counted board widgets and showed "—" for a stage with three flags, is now "Findings", the number of finding types on the stage. Core usage no longer rounds a short run's peak down to "0 cores": a chart window that runs past the last stage's end is averaged over the part the stages cover. ETL phases say they are summed stage time, which is why a phase can exceed the run. The executor chart steps between counts instead of drawing fractional executors, and its tooltip reads "At 7s: Active executors 2". The scaling estimate reads "with 5× the executors" instead of "at 500% executors", and a long card summary wraps under its value instead of cutting it off.

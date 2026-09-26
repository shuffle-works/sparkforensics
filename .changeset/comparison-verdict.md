---
"sparkforensics-web": minor
---

The run comparison page now leads with a verdict: whether run B finished faster or slower than run
A and by how much, which cost metrics got worse or better (changes under 2% read as about the
same), and which finding categories became more or less frequent (netted per category name, so a
category never reads as both). When either run had failed jobs, the verdict leads with that
instead, for example "Run B had 2 of 5 jobs fail (run A: none)" or "Run B's only job failed". When
either log has no end-of-run record, the verdict says how much run time each log covers, in a
neutral tone, rather than calling the cut-off run faster. A **See where to
start in run B** button opens run B's dashboard and its own next steps. The page header also stacks
on phones instead of pushing the page wider than the screen.

---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

Small wording fixes so the same thing reads the same way everywhere.

- Collapsed evidence cards count their findings in one form, "3 findings", instead of "3 issues flagged", "3 stages flagged", "1 item flagged" or "2 findings flagged".
- Spill and Shuffle I/O suggest a shuffle partition count in one form: "Try spark.sql.shuffle.partitions = 1520 (now 200 tasks; target 128 MB per partition)".
- Partition Sizing prints a stage's savings once per rule, not again above the rules, and a skewed partition over an empty median reads "far larger than the median, which is effectively empty".
- Stage Shape's low-parallelism row reads "Low parallelism: 0.25 tasks per core".
- Stage Summary shows "Scroll sideways to see all columns" only while the table is wider than its card.
- A duration of an hour or more reads "5h 59m" instead of "359m 18s", on the board and in the CLI report.
- Slow Executor Host rows and their findings name the metric in plain words, such as "Executor 3: 6.2× the median task time" and "Executor 3's shuffle read and write is 3× the median", instead of code names like shuffleBytes.
- ETL Phase Attribution explains its summed phase times in one shorter sentence, and Evidence availability rows in Advanced view drop a summary that only restated the row's state, keeping the observed count.

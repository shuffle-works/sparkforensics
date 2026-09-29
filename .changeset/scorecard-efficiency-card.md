---
"sparkforensics-web": patch
---

Compute Efficiency and Wasted Core-Hours are one card. The two Full app report cards showed the same allocated core-hours and the same waste share, one calling the total "available" and the other "allocated". Compute Efficiency now says "Allocated", adds the used core-hours and the top stages by task core-time that Wasted Core-Hours held, and its closing line names the larger waste with its fix, such as "Most of it is driver waste: review spark.driver.memory and spark.driver.cores before scaling executors." The Scorecard's Basic view captions say the stage-running time once, beside the figure it feeds: Wall-clock reads "Total run time." and Efficiency "Share of the run with a stage running (26.0s). Higher is better."

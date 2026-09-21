# Introduction

This guide is a hands-on reference for optimizing Spark and PySpark jobs. It covers [Spark
internals](#spark-architecture), [memory management](#memory-model), [joins](#joins),
[shuffle](#shuffle), [data formats](#data-formats), [PySpark-specific patterns](#pyspark),
[Adaptive Query Execution](#aqe) (AQE), and [cluster tuning](#cluster-config), followed by
a bottleneck diagnostic reference.

Read it top to bottom for a full grounding in Spark performance, or jump straight to the
**Bottleneck Reference** section below when you already know which symptom you're chasing.

## Severity dots

Each finding is marked with a severity dot:

- <span class="severity-dot info"></span> **Info**: worth knowing, not yet a problem
- <span class="severity-dot warning"></span> **Warning**: likely hurting job performance
- <span class="severity-dot critical"></span> **Critical**: actively bottlenecking the job

Each bottleneck section below documents the exact thresholds behind these dots.

## Tag system

Every bottleneck has a short tag used throughout this reference:

<span class="tag">SKEW</span> <span class="tag">SHFL</span> <span class="tag">SPILL</span>
<span class="tag">GC</span> <span class="tag">COLD</span> <span class="tag">UTIL</span>
<span class="tag">HOST</span> <span class="tag">FAIL</span> <span class="tag">STRAG</span>
<span class="tag">RETRY</span> <span class="tag">TINY</span> <span class="tag">FAIL-RATE</span>

See the [Bottleneck Reference](#bottleneck-skew) for what each one means, how it's detected,
and how to fix it.

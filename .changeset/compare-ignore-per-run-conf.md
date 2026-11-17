---
"sparkforensics-analyze": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
"sparkforensics": patch
---

Run comparison no longer counts `spark.app.initial.jar.urls`, `spark.driver.appUIAddress` and the AmIpFilter `PROXY_URI_BASES` key as configuration differences. Two runs of the same job can now reach the "same configuration and plan" verdict.

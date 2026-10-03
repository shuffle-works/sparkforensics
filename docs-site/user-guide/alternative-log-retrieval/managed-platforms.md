# Managed platforms

Where to find the Spark event log on each managed platform.

## Amazon EMR

EMR turns event logging on by default. On the cluster, the logs sit on HDFS
under `/var/log/spark/apps/`:

```bash
hdfs dfs -ls /var/log/spark/apps/
hdfs dfs -get /var/log/spark/apps/application_XXXX_XXXX .
```

If your cluster sets `spark.eventLog.dir` to an S3 path, download the file
from there instead (for example with `aws s3 cp`). AWS's
[EMR best-practices guide](https://aws.github.io/aws-emr-best-practices/docs/benchmarks/Analyzing/retrieve_event_logs/)
covers both.

## AWS Glue

Glue writes event logs to S3 when the job has the Spark UI turned on. In the
job parameters:

```text
--enable-spark-ui true
--spark-event-logs-path s3://my-bucket/spark-events/
--enable-spark-ui-legacy-path true
```

Glue has two log formats: Standard, for its own console, and Legacy, which
AWS documents for viewing on a Spark History Server. Ask for Legacy, as the
last parameter above does, or pick it in the console under **Spark UI logging
and monitoring configuration**.

After the run, download the file, or the rolling-log directory when the job
uses `spark.eventLog.rolling.enabled`, from that S3 path. See
[Enabling the Apache Spark web UI for AWS Glue jobs](https://docs.aws.amazon.com/glue/latest/dg/monitor-spark-ui-jobs.html).

## Databricks

Set up compute log delivery on the cluster or job compute before it runs:
**Advanced > Logging**, then pick a Unity Catalog volume, S3 or DBFS path.
Databricks delivers driver, worker and event logs into a subfolder of that
path named after the cluster ID, and keeps delivering until the compute
shuts down. Copy the event log from there. See
[compute log delivery](https://docs.databricks.com/aws/en/compute/configure#compute-log-delivery).

## Dataproc

Google Cloud Dataproc (also called Managed Service for Apache Spark) saves
Spark job history to the cluster's temp bucket, in its
`/spark-job-history` directory, unless the cluster sets
`spark.eventLog.dir` somewhere else. Download the file with
`gcloud storage cp`. See
[Persistent History Server](https://cloud.google.com/dataproc/docs/concepts/jobs/history-server).

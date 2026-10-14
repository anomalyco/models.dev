"""Bulk-copy legacy models.hit events using the existing generation-backfill Glue job.

Override --scriptLocation with this uploaded script, use a separate
--CHECKPOINT_PREFIX, and set --DRY_RUN=true first. The job's existing S3 Tables
reader, R2 catalog token and checkpoint bucket are reused. Never run concurrently
with the HTTP replay script. Both R2 tables are appended atomically, one table at
a time. Counts recover a committed append even if checkpointing was interrupted.
"""

import json
import sys
from datetime import datetime


def argument(name):
    flag = f"--{name}"
    return sys.argv[sys.argv.index(flag) + 1]


def optional(name):
    return argument(name) if f"--{name}" in sys.argv else None


def main():
    import boto3
    from awsglue.context import GlueContext
    from awsglue.job import Job
    from pyspark import SparkContext, StorageLevel
    from pyspark.sql import functions as F

    dry_run = argument("DRY_RUN").lower() == "true"
    s3 = boto3.client("s3")
    checkpoint_bucket = argument("CHECKPOINT_BUCKET")
    checkpoint_prefix = argument("CHECKPOINT_PREFIX").strip("/")
    start_at = optional("START_AT")
    end_at = optional("END_AT")
    if bool(start_at) != bool(end_at):
        raise ValueError("Use both START_AT and END_AT for a sample range")
    if checkpoint_prefix == "checkpoints/generation":
        raise ValueError("Use a separate models-hit checkpoint prefix")
    token = boto3.client("secretsmanager").get_secret_value(SecretId=argument("R2_SECRET_ARN"))["SecretString"]
    glue = GlueContext(SparkContext.getOrCreate())
    spark = glue.spark_session
    spark.conf.set("spark.sql.session.timeZone", "UTC")
    spark.conf.set("spark.sql.catalog.s3tables", "org.apache.iceberg.spark.SparkCatalog")
    spark.conf.set("spark.sql.catalog.s3tables.type", "rest")
    spark.conf.set("spark.sql.catalog.s3tables.uri", f"https://s3tables.{argument('SOURCE_REGION')}.amazonaws.com/iceberg")
    spark.conf.set("spark.sql.catalog.s3tables.warehouse", argument("SOURCE_WAREHOUSE"))
    spark.conf.set("spark.sql.catalog.s3tables.rest.sigv4-enabled", "true")
    spark.conf.set("spark.sql.catalog.s3tables.rest.signing-name", "s3tables")
    spark.conf.set("spark.sql.catalog.s3tables.rest.signing-region", argument("SOURCE_REGION"))
    spark.conf.set("spark.sql.catalog.s3tables.io-impl", "org.apache.iceberg.aws.s3.S3FileIO")
    spark.conf.set("spark.sql.catalog.s3tables.rest-metrics-reporting-enabled", "false")
    spark.conf.set("spark.sql.catalog.s3tables.http-client.apache.max-connections", "200")
    spark.conf.set("spark.sql.catalog.s3tables.http-client.apache.connection-acquisition-timeout-ms", "120000")
    spark.conf.set("spark.sql.catalog.r2", "org.apache.iceberg.spark.SparkCatalog")
    spark.conf.set("spark.sql.catalog.r2.type", "rest")
    spark.conf.set("spark.sql.catalog.r2.uri", argument("R2_CATALOG_URI"))
    spark.conf.set("spark.sql.catalog.r2.warehouse", argument("R2_WAREHOUSE"))
    spark.conf.set("spark.sql.catalog.r2.token", token)
    spark.conf.set("spark.sql.catalog.r2.header.X-Iceberg-Access-Delegation", "vended-credentials")
    spark.conf.set("spark.sql.catalog.r2.s3.remote-signing-enabled", "false")
    spark.conf.set("spark.sql.catalog.r2.http-client.apache.max-connections", "200")
    spark.conf.set("spark.sql.catalog.r2.http-client.apache.connection-acquisition-timeout-ms", "120000")
    job = Job(glue)
    job.init(argument("JOB_NAME"), {})

    plan_key = f"{checkpoint_prefix}/plan.json"
    try:
        plan = json.loads(s3.get_object(Bucket=checkpoint_bucket, Key=plan_key)["Body"].read())
        if (plan["source_warehouse"] != argument("SOURCE_WAREHOUSE") or plan["source_table"] != argument("SOURCE_TABLE") or plan["target_warehouse"] != argument("R2_WAREHOUSE")
            or plan.get("start_at") != start_at or plan.get("end_at") != end_at):
            raise ValueError("Checkpoint belongs to different source or destination")
    except s3.exceptions.NoSuchKey:
        snapshot = spark.sql(f"SELECT snapshot_id FROM {argument('SOURCE_TABLE')}.history ORDER BY made_current_at DESC LIMIT 1").first()[0]
        plan = {
            "snapshot_id": snapshot,
            "source_warehouse": argument("SOURCE_WAREHOUSE"),
            "source_table": argument("SOURCE_TABLE"),
            "target_warehouse": argument("R2_WAREHOUSE"),
            "start_at": start_at,
            "end_at": end_at,
        }
        # Pin the source before any append so a resumed run reads the same rows.
        s3.put_object(Bucket=checkpoint_bucket, Key=plan_key, Body=json.dumps(plan), ContentType="application/json")

    source = spark.read.option("snapshot-id", str(plan["snapshot_id"])).table(plan["source_table"]).where(F.col("event_type") == "models.hit")
    if start_at:
        source = source.where((F.col("event_date") >= start_at[:10]) & (F.col("event_date") <= end_at[:10]) &
            (F.col("event_timestamp") >= start_at) & (F.col("event_timestamp") < end_at))
    source = source.select(
        F.to_timestamp("event_timestamp").alias("timestamp"),
        F.lit(None).cast("string").alias("method"),
        (nonempty(F, "path") if "path" in source.columns else F.lit(None).cast("string")).alias("path"),
        nonempty(F, "user_agent").alias("useragent"),
        nonempty(F, "ip").alias("ip"),
        nonempty(F, "cf_country").alias("cf_country"),
    ).persist(StorageLevel.DISK_ONLY)
    summary = source.agg(
        F.count("*").alias("records"),
        F.count(F.when(F.col("timestamp").isNull(), 1)).alias("invalid_timestamps"),
        F.min("timestamp").cast("string").alias("first"),
        F.max("timestamp").cast("string").alias("last"),
    ).first().asDict()
    print(json.dumps({"source": summary, "snapshot_id": plan["snapshot_id"], "dry_run": dry_run}), flush=True)
    if summary["invalid_timestamps"]:
        raise ValueError("Historical rows contain invalid timestamps")
    days = source.groupBy(F.date_format("timestamp", "yyyy-MM-dd").alias("day")).count().orderBy("day").collect()
    expected_days = {row["day"]: row["count"] for row in days}
    for target in ["r2.models.hit", "r2.default.event"]:
        expected = {"__ingest_ts", "timestamp", "method", "path", "useragent", "ip", "cf_country"} if target == "r2.models.hit" else {"__ingest_ts", "source", "type", "timestamp", "payload"}
        if set(spark.table(target).columns) != expected:
            raise ValueError(f"Unexpected target schema: {target}")
        target_days = historical_days(spark, F, target)
        target_count = sum(target_days.values())
        print(json.dumps({"target": target, "records": target_count, "expected_records": summary["records"]}), flush=True)
        if target_count and target_days != expected_days:
            raise ValueError(f"Target contains a partial or mismatched historical backfill: {target}")
        if dry_run:
            continue
        if not target_count:
            # The validated source has no null timestamps. Coalesce also makes
            # Spark's static schema non-nullable for the raw table's required field.
            rows = source.withColumn("timestamp", F.coalesce("timestamp", F.lit(datetime(1970, 1, 1)))).withColumn("__ingest_ts", F.current_timestamp())
            if target == "r2.default.event":
                rows = rows.select(
                    "__ingest_ts", F.lit("models").alias("source"), F.lit("hit").alias("type"), "timestamp",
                    F.to_json(F.struct("method", "path", "useragent", "ip", "cf_country"), {"ignoreNullFields": "true"}).alias("payload"),
                )
            rows.select(*spark.table(target).columns).writeTo(target).append()
            spark.sql(f"REFRESH TABLE {target}")
        verified_days = historical_days(spark, F, target)
        if verified_days != expected_days:
            raise ValueError(f"Destination daily counts do not match S3: {target}")
        result = {"source": summary, "snapshot_id": plan["snapshot_id"], "target": target, "daily_records": verified_days}
        s3.put_object(Bucket=checkpoint_bucket, Key=f"{checkpoint_prefix}/{target}.json", Body=json.dumps(result), ContentType="application/json")
        print(json.dumps({"verified": target, "records": sum(verified_days.values())}), flush=True)
    source.unpersist()
    job.commit()


def nonempty(functions, column):
    return functions.when(functions.col(column) != "", functions.col(column)).otherwise(functions.lit(None).cast("string"))


def historical_days(spark, functions, target):
    rows = spark.table(target)
    if target == "r2.models.hit":
        rows = rows.where(functions.col("method").isNull())
    else:
        rows = rows.where((functions.col("source") == "models") & (functions.col("type") == "hit") & functions.get_json_object("payload", "$.method").isNull())
    return {row["day"]: row["count"] for row in rows.groupBy(functions.date_format("timestamp", "yyyy-MM-dd").alias("day")).count().collect()}


if __name__ == "__main__":
    main()

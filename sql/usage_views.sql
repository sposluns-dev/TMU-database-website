-- ===========================================================================
-- JICL website usage analytics — BigQuery views for the BI layer.
--
-- Run with:
--     bq query --use_legacy_sql=false < sql/usage_views.sql
--
-- TWO SOURCES, ONE SHAPE.
--   run_googleapis_com_requests   the live log sink (jicl-usage-to-bq), nested,
--                                 day-partitioned, growing continuously.
--   requests_historical           the one-off backfill of 2026-07-22 .. 2026-08-12
--                                 rescued before Cloud Logging's ~30-day retention
--                                 expired it (scripts/flatten_usage_logs.py).
--
-- v_usage_events unions them and presents ONE flat row per request, so Power BI
-- (or anything else) never has to know there were two sources. Deduped on
-- insertId, which is unique per log entry, so re-running the backfill over a
-- window the sink already covered cannot double-count.
--
-- WHY THE URL PARSING LIVES HERE
-- The JICL search runs server-side, so the request URL *is* the user's behaviour:
-- /search carries the query text and every active filter. The query string has to
-- be picked apart to be useful, and doing it in the view means the BI layer sees
-- plain columns instead of regexes in DAX.
-- ===========================================================================

-- Query-string values are percent-encoded and use '+' for spaces
-- ("religious+freedom", "Ontario%20(AG)"). BigQuery has no built-in URL decoder,
-- so this is the smallest possible JS UDF. SAFE-guarded: decodeURIComponent throws
-- on a malformed escape (a truncated %E2, a bare % from a probe/scanner), and one
-- bad row must not fail the whole query.
CREATE OR REPLACE FUNCTION `project-5ee8f952-cf97-4da1-a46.jicl_usage.urldecode`(s STRING)
RETURNS STRING
LANGUAGE js AS r"""
  if (s === null) return null;
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); }
  catch (e) { return s; }
""";

CREATE OR REPLACE VIEW `project-5ee8f952-cf97-4da1-a46.jicl_usage.v_usage_events` AS
WITH
-- ---------------------------------------------------------------------------
-- Live sink rows, flattened to match the historical table's shape.
-- ---------------------------------------------------------------------------
live AS (
  SELECT
    timestamp,
    insertId                                              AS insert_id,
    httpRequest.requestMethod                             AS method,
    httpRequest.requestUrl                                AS url,
    REGEXP_EXTRACT(httpRequest.requestUrl, r'^[^?]*')     AS full_url_no_qs,
    httpRequest.status                                    AS status,
    httpRequest.latency                                   AS latency_s,
    httpRequest.responseSize                              AS response_size,
    httpRequest.userAgent                                 AS user_agent,
    httpRequest.referer                                   AS referer,
    httpRequest.remoteIp                                  AS remote_ip,
    resource.labels.revision_name                         AS revision,
  FROM `project-5ee8f952-cf97-4da1-a46.jicl_usage.run_googleapis_com_requests`
),
live_shaped AS (
  SELECT
    timestamp, insert_id, method, url, status, latency_s, response_size,
    user_agent, referer, remote_ip, revision,
    -- Path is everything after the host, before the query string.
    REGEXP_EXTRACT(full_url_no_qs, r'^https?://[^/]+(/.*)$') AS path,
    -- Scalar params.
    `project-5ee8f952-cf97-4da1-a46.jicl_usage.urldecode`(
        REGEXP_EXTRACT(url, r'[?&]q=([^&]*)'))               AS q,
    `project-5ee8f952-cf97-4da1-a46.jicl_usage.urldecode`(
        REGEXP_EXTRACT(url, r'[?&]name_q=([^&]*)'))          AS name_q,
    REGEXP_EXTRACT(url, r'[?&]sort=([^&]*)')                 AS sort,
    REGEXP_EXTRACT(url, r'[?&]level=([^&]*)')                AS level,
    REGEXP_EXTRACT(url, r'[?&]language=([^&]*)')             AS language,
    SAFE_CAST(REGEXP_EXTRACT(url, r'[?&]limit=([^&]*)') AS INT64)  AS limit_,
    SAFE_CAST(REGEXP_EXTRACT(url, r'[?&]offset=([^&]*)') AS INT64) AS offset_,
    -- Repeatable params: several copies of the same key. Joined into one
    -- delimited string -- Power BI slices that far more easily than a repeated
    -- field, and the cardinality here is tiny.
    ARRAY_TO_STRING(ARRAY(
      SELECT `project-5ee8f952-cf97-4da1-a46.jicl_usage.urldecode`(x)
      FROM UNNEST(REGEXP_EXTRACT_ALL(url, r'[?&]court=([^&]*)')) x), ' | ')    AS court,
    ARRAY_TO_STRING(ARRAY(
      SELECT `project-5ee8f952-cf97-4da1-a46.jicl_usage.urldecode`(x)
      FROM UNNEST(REGEXP_EXTRACT_ALL(url, r'[?&]province=([^&]*)')) x), ' | ') AS province,
    ARRAY_TO_STRING(ARRAY(
      SELECT `project-5ee8f952-cf97-4da1-a46.jicl_usage.urldecode`(x)
      FROM UNNEST(REGEXP_EXTRACT_ALL(url, r'[?&]practice_area=([^&]*)')) x), ' | ')
                                                                              AS practice_area,
    ARRAY_TO_STRING(ARRAY(
      SELECT x FROM UNNEST(REGEXP_EXTRACT_ALL(url, r'[?&]keyword=([^&]*)')) x), ' | ')
                                                                              AS keyword,
    ARRAY_LENGTH(REGEXP_EXTRACT_ALL(url, r'[?&]court=([^&]*)'))
      + ARRAY_LENGTH(REGEXP_EXTRACT_ALL(url, r'[?&]province=([^&]*)'))
      + ARRAY_LENGTH(REGEXP_EXTRACT_ALL(url, r'[?&]practice_area=([^&]*)'))
      + ARRAY_LENGTH(REGEXP_EXTRACT_ALL(url, r'[?&]keyword=([^&]*)'))          AS filter_count,
  FROM live
),
-- ---------------------------------------------------------------------------
-- Backfilled rows: already flat, parsed in Python by flatten_usage_logs.py.
-- ---------------------------------------------------------------------------
hist AS (
  SELECT
    timestamp, insert_id, method, url, status, latency_s, response_size,
    user_agent, referer, remote_ip, revision, path,
    p_q AS q, p_name_q AS name_q, p_sort AS sort, p_level AS level,
    p_language AS language,
    SAFE_CAST(p_limit AS INT64) AS limit_, SAFE_CAST(p_offset AS INT64) AS offset_,
    p_court AS court, p_province AS province, p_practice_area AS practice_area,
    p_keyword AS keyword, filter_count,
  FROM `project-5ee8f952-cf97-4da1-a46.jicl_usage.requests_historical`
),
combined AS (
  SELECT * FROM live_shaped
  UNION ALL
  SELECT * FROM hist
)
SELECT
  timestamp,
  DATE(timestamp)                                        AS event_date,
  EXTRACT(HOUR FROM timestamp)                           AS event_hour,
  FORMAT_DATE('%A', DATE(timestamp))                     AS day_of_week,
  insert_id, method, path, url, status, latency_s, response_size,
  -- Collapse /case/LC1 -> /case so the column groups; bucket anything unknown
  -- so a probe or typo cannot invent a new endpoint category in the dashboard.
  CASE
    WHEN path LIKE '/case/%' THEN '/case'
    WHEN path IN ('/search', '/facets', '/keywords', '/health', '/stats', '/') THEN path
    ELSE 'other'
  END                                                    AS endpoint,
  CASE WHEN path LIKE '/case/%'
       THEN REGEXP_EXTRACT(path, r'^/case/([^/?]+)') END AS case_id,
  q, name_q, court, province, practice_area, keyword, sort, level, language,
  limit_, offset_, filter_count,
  (path = '/search')                                     AS is_search,
  (q IS NOT NULL AND q != '')                            AS has_query_text,
  (status >= 400)                                        AS is_error,
  user_agent, referer, remote_ip, revision,
FROM combined
-- insertId is unique per log entry, so this makes the union idempotent even where
-- the backfill window and the live sink overlap.
QUALIFY ROW_NUMBER() OVER (PARTITION BY insert_id ORDER BY timestamp) = 1;

-- ===========================================================================
-- Convenience rollup: one row per distinct search query. This is the table that
-- answers "what are people actually looking for", which is the whole point.
-- ===========================================================================
CREATE OR REPLACE VIEW `project-5ee8f952-cf97-4da1-a46.jicl_usage.v_search_queries` AS
SELECT
  q                                        AS search_query,
  COUNT(*)                                 AS times_run,
  COUNT(DISTINCT DATE(timestamp))          AS days_seen,
  MIN(timestamp)                           AS first_run,
  MAX(timestamp)                           AS last_run,
  ROUND(AVG(latency_s), 4)                 AS avg_latency_s,
  ROUND(MAX(latency_s), 4)                 AS max_latency_s,
  COUNTIF(filter_count > 0)                AS times_with_filters,
  ROUND(AVG(filter_count), 2)              AS avg_filters,
  COUNT(DISTINCT remote_ip)                AS distinct_ips,
FROM `project-5ee8f952-cf97-4da1-a46.jicl_usage.v_usage_events`
WHERE is_search AND has_query_text
GROUP BY q;

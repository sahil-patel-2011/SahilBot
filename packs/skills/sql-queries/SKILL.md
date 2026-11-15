---
name: sql-queries
description: Write and run correct, safe SQL on SQLite, Postgres or MySQL - schema first, parameters, NULL and GROUP BY rules, EXPLAIN, guarded writes.
source: you
uses: 0
category: Coding
triggers: sql query, left join, group by, window function, row_number over, explain analyze, postgres query, psql, sqlite3, mysql query, create index, transaction isolation, is null, slow query, update where, delete from
---

## When
Querying or changing a relational database, or writing SQL inside code. For pandas analysis of the results read python-data-analysis.

## Steps
1. Identify the engine and version (sqlite3 --version, SELECT version()). Syntax differs.
2. Inspect the schema; never guess names. SQLite: .tables, .schema orders. Postgres: \dt, \d orders, or information_schema.columns. MySQL: SHOW TABLES; SHOW CREATE TABLE orders. Note primary keys, foreign keys, NOT NULL, indexes.
3. Connect read-only when you can: sqlite3 -readonly app.db; Postgres BEGIN READ ONLY or SET default_transaction_read_only = on. Don't print connection strings that contain passwords.
4. Explore with LIMIT 50 and SELECT COUNT(*) first. Build joins one table at a time and check the row count after each; a jump means fan-out.
5. Present the final query, a result sample, and what it means.

## Writes (UPDATE, DELETE, INSERT ... SELECT, DDL)
1. Run SELECT COUNT(*) and a sample with the exact same WHERE. Show both to the user and get an explicit OK.
2. BEGIN; run the statement; check affected rows equal the count; COMMIT only then, else ROLLBACK.
3. Never DROP, TRUNCATE, or an UPDATE/DELETE without WHERE unless the user asked in those words. Suggest a backup (sqlite3 app.db ".backup bak.db", pg_dump -t) for bulk changes.

## Correctness rules
- Parameterize every value: ? (SQLite, MySQL drivers), $1 (Postgres), %s or named params (psycopg), never string formatting. Table/column names can't be parameters; whitelist them.
- NULL: = NULL is never true; use IS NULL / IS NOT NULL, IS DISTINCT FROM in Postgres. NOT IN (subquery) returns nothing if the subquery has a NULL; use NOT EXISTS. COUNT(col) skips NULLs, COUNT(*) doesn't. COALESCE for defaults.
- LEFT JOIN: conditions on the right table belong in ON; in WHERE they turn it into an inner join.
- GROUP BY: every selected non-aggregate column must be grouped (Postgres and MySQL ONLY_FULL_GROUP_BY enforce it; SQLite silently picks an arbitrary row). WHERE filters rows, HAVING filters groups.
- Aggregating after a one-to-many join double counts; aggregate in a subquery or CTE first, then join.
- Integer division truncates in SQLite and Postgres (5/2 = 2); cast one side.
- Store timestamps in UTC (timestamptz in Postgres); compare ranges with >= start AND < end.

## Window functions
- Top-N per group: ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) in a CTE, then WHERE rn <= 3.
- Running total: SUM(amount) OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW).
- LAG/LEAD for previous/next row deltas. Supported in SQLite 3.25+, MySQL 8+, all modern Postgres.

## Performance
- Plans: SQLite EXPLAIN QUERY PLAN; Postgres EXPLAIN (ANALYZE, BUFFERS); MySQL EXPLAIN or EXPLAIN ANALYZE (8.0.18+). ANALYZE executes the statement, so wrap writes in BEGIN ... ROLLBACK.
- Look for sequential scans on big tables, row estimates far off actuals, and sorts spilling to disk.
- Index columns used in WHERE, JOIN and ORDER BY. Composite indexes follow the left prefix: equality columns first, then the range column. Functions on a column (LOWER(email)) or a leading wildcard (LIKE '%x') skip the index unless you build an expression index.
- Every index slows writes; propose, don't add, on production tables. Postgres: CREATE INDEX CONCURRENTLY.
- Select needed columns, not *, in application code; paginate with keyset (WHERE id > last ORDER BY id LIMIT n) over large OFFSET.

## Transactions
Defaults: Postgres READ COMMITTED, MySQL InnoDB REPEATABLE READ, SQLite serializable with one writer. Avoid lost updates with UPDATE ... SET qty = qty - 1 WHERE qty > 0, or SELECT ... FOR UPDATE inside the transaction. Keep transactions short.

## Example
```sql
SELECT COUNT(*) FROM sessions WHERE last_seen < '2026-01-01';  -- 1,204 rows, user approved
BEGIN;
DELETE FROM sessions WHERE last_seen < '2026-01-01';            -- expect 1204
COMMIT;
```

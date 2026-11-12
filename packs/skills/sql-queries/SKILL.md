---
name: sql-queries
description: Write and run correct SQL against a database (SQLite, Postgres, MySQL).
source: you
uses: 0
category: Coding
---

1. Inspect the schema first (tables, columns, keys, indexes). Never guess column names.
2. Build the query step by step; check row counts at each join to catch duplication.
3. Read-only queries run freely; anything that changes data (UPDATE, DELETE, DROP) needs the user's OK and a backup or transaction.
4. Performance: EXPLAIN, indexes on filter/join columns, no SELECT * in production code.
5. Show the query, a sample of results and what they mean.

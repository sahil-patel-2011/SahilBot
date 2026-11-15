---
name: database-schema-migrations
description: Design database schemas (keys, constraints, indexes) and write reversible, zero-downtime migrations with expand/contract, safe backfills and tests.
source: you
uses: 0
category: Coding
triggers: database schema, schema migration, alembic, prisma migrate, flyway, add a column, zero downtime migration, backfill, foreign key, add an index, normalize tables, expand and contract, liquibase, rename a column, knex migration
---

## When
New tables, schema changes, indexes, data backfills, ORM migration files. Writing queries: sql-queries. The API on top: api-design.

## Schema design
- Primary keys: surrogate bigint identity, or UUIDv7/ULID when IDs are generated outside the DB; natural keys get a UNIQUE constraint.
- Constraints in the database: NOT NULL by default, FOREIGN KEY with explicit ON DELETE, UNIQUE, CHECK for enums and ranges.
- Types: timestamptz in UTC; integer minor units or numeric for money, never float; real booleans; JSONB only for genuinely schemaless parts.
- Normalize to 3NF by default; denormalize only for a measured hot read path, with a defined sync mechanism.
- Indexes: every foreign key plus frequent WHERE, JOIN and ORDER BY columns; in composites, equality columns before range or sort columns; partial indexes for hot subsets. Each index costs writes; check with EXPLAIN.
- One naming convention (follow the repo); created_at and updated_at; soft delete only when needed, with partial unique indexes.

## Migration rules
1. Generate every change with the project's tool and commit it with the code: Prisma (`prisma migrate dev --name add_x`; deploy with `prisma migrate deploy`), Alembic (`alembic revision --autogenerate -m "add x"`, then read and fix the file), Flyway (`V3__add_x.sql`), or the Rails/Django/Knex/TypeORM equivalent.
2. Never edit a migration that ran in a shared environment; add a new one.
3. Write the down/downgrade, or state why it is irreversible and get the user's sign-off.
4. Read the generated SQL: ORMs may treat a rename as drop plus add and lose the data.
5. Keep large data backfills out of schema-migration transactions.

## Zero downtime (expand / contract)
Old and new app versions run together during a deploy, so each step must work with both.
1. Expand: add the column or table nullable or with a constant default; build indexes with `CREATE INDEX CONCURRENTLY` (Postgres; not inside a transaction).
2. Dual-write old and new.
3. Backfill in batches (1k-10k rows per transaction by id range, short pauses), idempotent and resumable; never one giant UPDATE.
4. Switch reads to the new shape; verify counts or checksums.
5. Contract: stop writing old, drop it in a later release.
Rename = add, copy, switch, drop. New NOT NULL: add nullable, backfill, `ADD CONSTRAINT ... CHECK (col IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT`, then SET NOT NULL.

## Dangerous on big tables
Column type changes, volatile defaults (older Postgres), foreign keys without NOT VALID, non-concurrent index builds, MySQL ALTERs without online DDL (use gh-ost or pt-online-schema-change). Set `lock_timeout` so a blocked migration fails fast instead of stalling traffic.

## Verify
- Up, down, up on a fresh local DB, then on a copy with realistic volume.
- App tests pass on the new schema; the previous app version still works on the expanded schema.
- EXPLAIN new queries.
- Ask before running migrations against any non-local database; back up before destructive ones.

## Pitfalls
- Relying on ORM validation instead of constraints.
- Missing indexes on foreign keys.
- Dropping a column in the same release that stops using it.

---
name: database-migration
description: Writes safe SQL/NoSQL schema and data migrations with rollbacks, indexing advice and a dry run before anything touches real data.
---
# Workflow: Database Migration

1. **Learn the setup:** migration tool (Prisma, Alembic, Flyway, Knex, Rails, Django, raw SQL…), naming/numbering scheme, the database engine and version. Read recent migrations and follow their style.
2. **Classify the change:** additive (new nullable column/table/index), or risky (drop/rename, type change, NOT NULL on existing data, big backfill, lock-heavy index build).
3. **Use the expand → migrate → contract pattern for risky changes:** add the new structure first, deploy code that writes both, backfill in batches, switch reads, only then remove the old structure in a later migration.
4. **Write both directions:** an `up` and a working `down` (or state clearly why a step is irreversible and what the backup/recovery plan is).
5. **Engine-aware details:** PostgreSQL → `CREATE INDEX CONCURRENTLY`, `ADD COLUMN` with a default is cheap on modern versions, `NOT VALID` + `VALIDATE CONSTRAINT`; MySQL → check online DDL support; backfills in batches with a bounded transaction; always index foreign keys and columns used in frequent filters/joins, and check with `EXPLAIN`.
6. **Dry run:** apply to a throwaway or local database (never production) and run `up`, `down`, `up` again; run the project's tests. Show the generated SQL when the tool can print it.
7. **Report:** the migration files, whether they lock tables and for how long (estimated), irreversible steps, rollout order with the application code.

Rules: **never run a migration against a database you were not explicitly told to use**; never put credentials in files; ask with the `question` tool before any DROP, TRUNCATE or destructive data update, even in a "dry run" on a shared database.

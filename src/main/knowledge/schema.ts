// The knowledge base's tables (also created by the database migration in db.ts). Plain tables only: the
// FTS5 keyword index is created at runtime by KnowledgeStore, because a SQLite build without FTS5 must
// still open the database (it then ranks with BM25 over kb_terms instead).
// Never edit statements here once shipped; add new IF NOT EXISTS statements or a new migration.
export const KNOWLEDGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS kb_sources (
    path TEXT PRIMARY KEY, kind TEXT NOT NULL, space_id TEXT, added_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS kb_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, root TEXT NOT NULL, kind TEXT NOT NULL,
    size INTEGER NOT NULL, mtime INTEGER NOT NULL, hash TEXT NOT NULL, chunks INTEGER NOT NULL DEFAULT 0,
    skipped TEXT, indexed_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS kb_docs_root ON kb_docs(root);
  CREATE TABLE IF NOT EXISTS kb_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, text TEXT NOT NULL, heading TEXT, start_line INTEGER, end_line INTEGER, page INTEGER,
    tokens INTEGER NOT NULL, nterms INTEGER NOT NULL DEFAULT 0, embedding BLOB, emb_model TEXT);
  CREATE INDEX IF NOT EXISTS kb_chunks_doc ON kb_chunks(doc_id, seq);
  CREATE INDEX IF NOT EXISTS kb_chunks_emb ON kb_chunks(emb_model);
  CREATE TABLE IF NOT EXISTS kb_terms (
    term TEXT NOT NULL, chunk_id INTEGER NOT NULL REFERENCES kb_chunks(id) ON DELETE CASCADE, tf INTEGER NOT NULL,
    PRIMARY KEY (term, chunk_id)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS kb_terms_chunk ON kb_terms(chunk_id);
  CREATE TABLE IF NOT EXISTS kb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`

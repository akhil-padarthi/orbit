import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

let db = null;
const statements = new Map();

/** Open (or create) the SQLite database and apply the schema. Idempotent. */
export function openDatabase(file) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  return db;
}

export function closeDatabase() {
  statements.clear();
  db?.close();
  db = null;
}

function stmt(sql) {
  if (!db) throw new Error('Database not opened');
  let s = statements.get(sql);
  if (!s) {
    s = db.prepare(sql);
    statements.set(sql, s);
  }
  return s;
}

// node:sqlite rejects undefined and booleans; normalise parameters.
const clean = (params) =>
  params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

/** Return the first row or undefined. */
export const one = (sql, ...params) => {
  const row = stmt(sql).get(...clean(params));
  return row ? { ...row } : undefined;
};
/** Return all rows. */
export const all = (sql, ...params) => stmt(sql).all(...clean(params)).map((r) => ({ ...r }));
/** Execute a write; returns { changes, lastInsertRowid }. */
export const run = (sql, ...params) => stmt(sql).run(...clean(params));

let txDepth = 0;
/** Run fn inside a transaction (nested calls join the outer transaction). */
export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

/** Parse JSON columns safely. */
export const parseJson = (value, fallback = null) => {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

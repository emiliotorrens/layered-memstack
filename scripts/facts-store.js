#!/usr/bin/env node
/**
 * facts-store.js — Structured KV facts store with a confidence ladder.
 *
 * Inspired by mnemo-cortex's Facts store: when semantic search is the wrong
 * tool (names, settings, IDs, entity attributes), you want an exact,
 * sub-millisecond lookup instead of an embedding match.
 *
 * Facts are (entity, attribute, value) triples with a three-state confidence
 * ladder:  verified  >  high_probability  >  false
 * New evidence promotes or demotes automatically (see reconcile()).
 *
 * Zero external deps: uses Node's built-in node:sqlite (Node >= 22.5).
 * The DB is a single local file — no daemon, no server, fits the
 * markdown-first / no-heavy-infra philosophy of layered-memstack.
 *
 * Usage:
 *   node facts-store.js save <entity> <attribute> <value> [--confidence C] [--source S]
 *   node facts-store.js get <entity> <attribute>
 *   node facts-store.js query [--entity E] [--attribute A] [--confidence C] [--json]
 *   node facts-store.js demote <entity> <attribute> [--source S]
 *   node facts-store.js forget <entity> <attribute>
 *
 * Env:
 *   FACTS_DB   override DB path (default: <workspace>/data/facts.db)
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// --- confidence ladder ----------------------------------------------------
const LADDER = ['false', 'high_probability', 'verified'];
const RANK = Object.fromEntries(LADDER.map((c, i) => [c, i]));

function isConfidence(c) {
  return Object.prototype.hasOwnProperty.call(RANK, c);
}

// --- db -------------------------------------------------------------------
function defaultDbPath() {
  if (process.env.FACTS_DB) return process.env.FACTS_DB;
  // scripts/ lives at <pkg>/scripts, workspace is 3 levels up from here.
  const workspace = path.resolve(__dirname, '..', '..', '..');
  return path.join(workspace, 'data', 'facts.db');
}

function openDb() {
  const dbPath = defaultDbPath();
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      entity      TEXT NOT NULL,
      attribute   TEXT NOT NULL,
      value       TEXT NOT NULL,
      confidence  TEXT NOT NULL DEFAULT 'high_probability',
      source      TEXT,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (entity, attribute)
    );
    CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity);
    CREATE INDEX IF NOT EXISTS idx_facts_attribute ON facts(attribute);
  `);
  return db;
}

function nowIso() {
  // Wall-clock timestamp; injectable for tests via FACTS_NOW.
  return process.env.FACTS_NOW || new Date().toISOString();
}

// --- reconciliation logic -------------------------------------------------
/**
 * Decide the stored state when new evidence arrives for an existing fact.
 * - Same value  -> promote confidence to the higher of old/new.
 * - New value with >= confidence -> replace (new evidence wins).
 * - New value with lower confidence -> keep old, but never silently drop a
 *   contradiction: caller is told via `conflict`.
 */
function reconcile(existing, incoming) {
  if (!existing) return { row: incoming, action: 'created', conflict: false };

  if (existing.value === incoming.value) {
    const best = RANK[incoming.confidence] >= RANK[existing.confidence]
      ? incoming.confidence : existing.confidence;
    return {
      row: { ...existing, confidence: best, source: incoming.source || existing.source, updated_at: incoming.updated_at },
      action: best === existing.confidence ? 'unchanged' : 'promoted',
      conflict: false,
    };
  }

  // Different value => contradiction.
  if (RANK[incoming.confidence] >= RANK[existing.confidence]) {
    return { row: incoming, action: 'replaced', conflict: true };
  }
  return { row: existing, action: 'rejected', conflict: true };
}

// --- operations -----------------------------------------------------------
function save(db, { entity, attribute, value, confidence, source }) {
  confidence = confidence || 'high_probability';
  if (!isConfidence(confidence)) {
    throw new Error(`invalid confidence '${confidence}' (use: ${LADDER.join(', ')})`);
  }
  const existing = db.prepare(
    'SELECT * FROM facts WHERE entity = ? AND attribute = ?'
  ).get(entity, attribute);

  const incoming = { entity, attribute, value, confidence, source: source || null, updated_at: nowIso() };
  const { row, action, conflict } = reconcile(existing, incoming);

  db.prepare(`
    INSERT INTO facts (entity, attribute, value, confidence, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity, attribute) DO UPDATE SET
      value = excluded.value,
      confidence = excluded.confidence,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(row.entity, row.attribute, row.value, row.confidence, row.source, row.updated_at);

  return { action, conflict, fact: row, previous: existing || null };
}

function get(db, entity, attribute) {
  return db.prepare(
    'SELECT * FROM facts WHERE entity = ? AND attribute = ?'
  ).get(entity, attribute) || null;
}

function query(db, { entity, attribute, confidence }) {
  const where = [];
  const args = [];
  if (entity) { where.push('entity = ?'); args.push(entity); }
  if (attribute) { where.push('attribute = ?'); args.push(attribute); }
  if (confidence) { where.push('confidence = ?'); args.push(confidence); }
  const sql = 'SELECT * FROM facts'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY entity, attribute';
  return db.prepare(sql).all(...args);
}

// Mark a fact wrong without supplying a replacement value (mnemo's demote).
function demote(db, entity, attribute, source) {
  const existing = get(db, entity, attribute);
  if (!existing) return { action: 'missing', fact: null };
  db.prepare(
    'UPDATE facts SET confidence = ?, source = ?, updated_at = ? WHERE entity = ? AND attribute = ?'
  ).run('false', source || existing.source, nowIso(), entity, attribute);
  return { action: 'demoted', fact: get(db, entity, attribute) };
}

function forget(db, entity, attribute) {
  const info = db.prepare(
    'DELETE FROM facts WHERE entity = ? AND attribute = ?'
  ).run(entity, attribute);
  return { action: info.changes ? 'forgotten' : 'missing' };
}

// --- cli ------------------------------------------------------------------
function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (key === 'json') { flags.json = true; continue; }
      flags[key] = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

function fmtFact(f) {
  if (!f) return '(none)';
  const mark = { verified: '✓', high_probability: '~', false: '✗' }[f.confidence] || '?';
  return `${mark} ${f.entity} · ${f.attribute} = ${f.value}  [${f.confidence}${f.source ? ', src:' + f.source : ''}]`;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseFlags(rest);
  const db = openDb();

  try {
    switch (cmd) {
      case 'save': {
        const [entity, attribute, ...valueParts] = positional;
        if (!entity || !attribute || !valueParts.length) {
          throw new Error('usage: save <entity> <attribute> <value> [--confidence C] [--source S]');
        }
        const res = save(db, {
          entity, attribute, value: valueParts.join(' '),
          confidence: flags.confidence, source: flags.source,
        });
        if (flags.json) { console.log(JSON.stringify(res)); break; }
        const note = res.conflict
          ? (res.action === 'replaced'
              ? ' (CONFLICT — overwrote a different value)'
              : ' (CONFLICT — kept existing, incoming had lower confidence)')
          : '';
        console.log(`${res.action}${note}: ${fmtFact(res.fact)}`);
        if (res.conflict && res.previous && res.action === 'replaced') console.log(`  was: ${fmtFact(res.previous)}`);
        break;
      }
      case 'get': {
        const [entity, attribute] = positional;
        if (!entity || !attribute) throw new Error('usage: get <entity> <attribute>');
        const f = get(db, entity, attribute);
        if (flags.json) { console.log(JSON.stringify(f)); break; }
        console.log(fmtFact(f));
        break;
      }
      case 'query': {
        const rows = query(db, { entity: flags.entity, attribute: flags.attribute, confidence: flags.confidence });
        if (flags.json) { console.log(JSON.stringify(rows)); break; }
        if (!rows.length) { console.log('(no matching facts)'); break; }
        rows.forEach((f) => console.log(fmtFact(f)));
        break;
      }
      case 'demote': {
        const [entity, attribute] = positional;
        if (!entity || !attribute) throw new Error('usage: demote <entity> <attribute> [--source S]');
        const res = demote(db, entity, attribute, flags.source);
        if (flags.json) { console.log(JSON.stringify(res)); break; }
        console.log(res.action === 'missing' ? '(no such fact)' : `demoted: ${fmtFact(res.fact)}`);
        break;
      }
      case 'forget': {
        const [entity, attribute] = positional;
        if (!entity || !attribute) throw new Error('usage: forget <entity> <attribute>');
        const res = forget(db, entity, attribute);
        console.log(res.action);
        break;
      }
      default:
        console.log('facts-store.js — commands: save, get, query, demote, forget');
        console.log('  save <entity> <attribute> <value> [--confidence verified|high_probability|false] [--source S]');
        console.log('  get <entity> <attribute>');
        console.log('  query [--entity E] [--attribute A] [--confidence C] [--json]');
        console.log('  demote <entity> <attribute>');
        console.log('  forget <entity> <attribute>');
        process.exitCode = cmd ? 1 : 0;
    }
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { openDb, save, get, query, demote, forget, reconcile, LADDER, RANK };

#!/usr/bin/env node
/**
 * hybrid-search.js — BM25 keyword search over the memory markdown, with a
 * Reciprocal Rank Fusion (RRF) helper to combine it with semantic ranking.
 *
 * Why: OpenClaw's native memory_search uses semantic embeddings (Gemini).
 * Embeddings are great for meaning but miss exact tokens — names, IDs, flags,
 * cron ids, filenames, accented proper nouns. BM25 keyword matching nails
 * those. Fusing both (mem0's "hybrid search") lifts recall a lot at ~zero cost.
 *
 * This script is the keyword half. It can run standalone (BM25 only) or fuse
 * an externally-provided semantic ranking via RRF.
 *
 * Zero external deps. Corpus = MEMORY.md + memory/*.md + reference/*.md.
 *
 * Usage:
 *   node hybrid-search.js "<query>" [--top N] [--json] [--semantic ranked.json]
 *
 * --semantic expects a JSON array of chunk ids ("relpath#Lnn") in semantic
 * rank order (best first); it is fused with the BM25 ranking via RRF.
 *
 * Env:
 *   MEMSTACK_ROOT   corpus root (default: the OpenClaw workspace, 3 dirs up)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// --- corpus location ------------------------------------------------------
function corpusRoot() {
  if (process.env.MEMSTACK_ROOT) return process.env.MEMSTACK_ROOT;
  return path.resolve(__dirname, '..', '..', '..'); // <pkg>/scripts -> workspace
}

function corpusFiles(root) {
  const files = [];
  const add = (p) => { if (fs.existsSync(p)) files.push(p); };
  add(path.join(root, 'MEMORY.md'));
  for (const dir of ['memory', 'reference']) {
    const d = path.join(root, dir);
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      if (name.endsWith('.md')) files.push(path.join(d, name));
    }
  }
  return files;
}

// --- text normalization (aligned with memory-dedup.js) --------------------
function normalize(line) {
  return line
    .replace(/<!--.*?-->/g, '')
    .replace(/\*\*/g, '')
    .replace(/[`_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/[-*]\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Compact ES/EN stopword set. Without this, ubiquitous words like "me"/"un"/
// "de" dominate matches and — worse — guarantee spurious hits that make the
// thesaurus-loop escalation gate think a junk search succeeded.
const STOPWORDS = new Set((
  'de la el los las un una unos unas y o u a ante con sin por para segun sobre ' +
  'tras que se su sus me mi te tu lo le les nos os al del es son era ser estar ' +
  'esta este estos estas eso esto esa ese como mas menos muy ya no si pero ' +
  'the of to in on at is are was be it this that for and or an as with'
).split(' '));

function tokenize(text) {
  // Accent-fold so "sesión"/"sesion" and "código"/"codigo" collide.
  // Spanish search is expected to be accent-insensitive; this strictly helps
  // recall and keeps the query and corpus on the same footing. (ñ preserved.)
  const folded = normalize(text)
    .replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e').replace(/[íìïî]/g, 'i')
    .replace(/[óòöô]/g, 'o').replace(/[úùüû]/g, 'u');
  return folded
    .split(/[^a-zñ0-9]+/i)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// --- chunking -------------------------------------------------------------
// One chunk per non-empty line, carrying its nearest heading as context so a
// bare bullet ("SL -4% / TP +6%") is still findable and readable in results.
function chunkFile(absPath, root) {
  const rel = path.relative(root, absPath);
  const lines = fs.readFileSync(absPath, 'utf8').split('\n');
  const chunks = [];
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const h = raw.match(/^#{1,6}\s+(.*)/);
    if (h) { heading = h[1].trim(); continue; }
    if (!raw.trim()) continue;
    const text = raw.trim();
    const tokens = tokenize(heading + ' ' + text);
    if (!tokens.length) continue;
    chunks.push({ id: `${rel}#L${i + 1}`, rel, line: i + 1, heading, text, tokens });
  }
  return chunks;
}

function buildCorpus(root = corpusRoot()) {
  const chunks = [];
  for (const f of corpusFiles(root)) chunks.push(...chunkFile(f, root));
  return chunks;
}

// --- BM25 -----------------------------------------------------------------
const K1 = 1.5;
const B = 0.75;

function bm25Rank(chunks, queryTokens) {
  const N = chunks.length;
  if (!N) return [];
  const avgLen = chunks.reduce((s, c) => s + c.tokens.length, 0) / N;

  // document frequency per query term
  const df = new Map();
  const qset = new Set(queryTokens);
  for (const c of chunks) {
    const seen = new Set();
    for (const t of c.tokens) {
      if (qset.has(t) && !seen.has(t)) { df.set(t, (df.get(t) || 0) + 1); seen.add(t); }
    }
  }
  const idf = new Map();
  for (const t of qset) {
    const n = df.get(t) || 0;
    // BM25+ idf floor keeps very common terms from going negative
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  const scored = [];
  for (const c of chunks) {
    const tf = new Map();
    for (const t of c.tokens) if (qset.has(t)) tf.set(t, (tf.get(t) || 0) + 1);
    if (!tf.size) continue;
    let score = 0;
    const len = c.tokens.length;
    for (const [t, f] of tf) {
      const num = f * (K1 + 1);
      const den = f + K1 * (1 - B + B * (len / avgLen));
      score += idf.get(t) * (num / den);
    }
    scored.push({ ...c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// --- Reciprocal Rank Fusion ----------------------------------------------
// Combine two (or more) ranked id lists. RRF is rank-based so it needs no
// score normalization between the keyword and semantic systems.
function rrfFuse(rankings, k = 60) {
  const score = new Map();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => {
      score.set(id, (score.get(id) || 0) + 1 / (k + i + 1));
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, s]) => ({ id, score: s }));
}

// --- public API -----------------------------------------------------------
function search(query, { root = corpusRoot(), top = 10, semantic = null } = {}) {
  const chunks = buildCorpus(root);
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const bm25 = bm25Rank(chunks, tokenize(query));

  let ranked;
  if (semantic && semantic.length) {
    // hybrid: fuse BM25 ids with the provided semantic id ordering
    const fused = rrfFuse([bm25.map((c) => c.id), semantic]);
    ranked = fused.map((r) => ({ ...(byId.get(r.id) || { id: r.id }), score: r.score }));
  } else {
    ranked = bm25;
  }
  return ranked.slice(0, top);
}

// --- cli ------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const flags = { top: 10 };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') flags.json = true;
    else if (args[i] === '--top') flags.top = parseInt(args[++i], 10);
    else if (args[i] === '--semantic') flags.semantic = args[++i];
    else positional.push(args[i]);
  }
  const query = positional.join(' ');
  if (!query) {
    console.log('usage: hybrid-search.js "<query>" [--top N] [--json] [--semantic ranked.json]');
    process.exitCode = 1;
    return;
  }
  let semantic = null;
  if (flags.semantic) {
    try { semantic = JSON.parse(fs.readFileSync(flags.semantic, 'utf8')); }
    catch (e) { console.error(`could not read --semantic file: ${e.message}`); process.exitCode = 1; return; }
  }

  const results = search(query, { top: flags.top, semantic });
  if (flags.json) { console.log(JSON.stringify(results, null, 2)); return; }
  if (!results.length) { console.log('(no matches)'); return; }
  for (const r of results) {
    const where = r.heading ? `${r.rel} › ${r.heading}` : r.rel;
    console.log(`[${r.score.toFixed(3)}] ${r.id}`);
    console.log(`  ${r.text}`);
    console.log(`  ↳ ${where}`);
  }
}

if (require.main === module) main();

module.exports = { search, bm25Rank, rrfFuse, buildCorpus, tokenize };

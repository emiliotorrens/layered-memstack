#!/usr/bin/env node
/**
 * thesaurus-loop.js — Multi-query retrieval that only fires on a miss.
 *
 * Problem (mnemo-cortex's "assumption misalignment"): every search commits to
 * one phrasing. If a memory was filed under different words than you searched
 * for, the match is weak or empty. The Thesaurus Loop fans a failed query into
 * several alternative phrasings, searches them all, and fuses the best matches.
 *
 * Key design: ESCALATION-ONLY. A good search returns immediately and pays
 * nothing. The expansion only runs when the first search whiffs — which is
 * exactly when it's worth paying for.
 *
 * Two-tier escalation (chosen: local-first, LLM-if-still-empty):
 *   Tier 0  plain hybrid/BM25 search
 *   Tier 1  LOCAL expansion — accent folding, singular/plural, synonym map.
 *           Zero deps, zero network, instant.
 *   Tier 2  LLM expansion — gemini-2.5-flash generates alternative phrasings.
 *           Only if Tier 1 still comes back empty/weak AND a key is present.
 *
 * All candidate rankings are fused with RRF (from hybrid-search.js).
 *
 * Usage:
 *   node thesaurus-loop.js "<query>" [--top N] [--min M] [--no-llm] [--json] [--verbose]
 *
 * Env:
 *   GOOGLE_API_KEY   enables the Tier 2 LLM expansion (optional)
 *   MEMSTACK_ROOT    corpus root (passed through to hybrid-search)
 */

'use strict';

const fs = require('node:fs');
const { search, bm25Rank, rrfFuse, buildCorpus, tokenize } = require('./hybrid-search');

// --- local (Tier 1) query expansion --------------------------------------
function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Small, extensible ES synonym map. Kept intentionally tiny — the heavy
// lifting is morphological. Add domain terms here as they prove useful.
const SYNONYMS = {
  vuelo: ['avión', 'vuelos', 'aéreo'],
  coche: ['auto', 'vehículo'],
  medico: ['médico', 'salud', 'clínico'],
  viaje: ['viajes', 'escapada', 'trip'],
  reunion: ['reunión', 'meeting'],
  precio: ['precios', 'tarifa', 'coste'],
  casa: ['hogar', 'vivienda'],
  peso: ['báscula', 'kg'],
  presion: ['presión', 'tensión', 'arterial'],
};

function morphVariants(token) {
  const out = new Set([token]);
  const noAcc = stripAccents(token);
  out.add(noAcc);
  // naive singular/plural
  if (token.endsWith('es') && token.length > 4) out.add(token.slice(0, -2));
  else if (token.endsWith('s') && token.length > 3) out.add(token.slice(0, -1));
  else out.add(token + 's');
  // synonyms (keyed by accent-folded form)
  const syn = SYNONYMS[noAcc] || SYNONYMS[token];
  if (syn) syn.forEach((s) => out.add(s));
  return [...out];
}

// Produce a handful of alternative query strings from the original.
function localExpansions(query, limit = 6) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const variants = new Set();

  // 1) fully accent-folded query
  variants.add(stripAccents(query));

  // 2) swap one token at a time for each of its morph/synonym variants
  for (let i = 0; i < tokens.length; i++) {
    for (const alt of morphVariants(tokens[i])) {
      if (alt === tokens[i]) continue;
      if (tokens.includes(alt)) continue; // avoid junk like "arterial arterial"
      const copy = tokens.slice();
      copy[i] = alt;
      variants.add(copy.join(' '));
    }
  }
  variants.delete(query.toLowerCase());
  return [...variants].slice(0, limit);
}

// --- LLM (Tier 2) query expansion ----------------------------------------
async function llmExpansions(query, n = 5) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return [];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
  const prompt = `Eres un motor de expansión de consultas para búsqueda en una memoria personal en español.
Genera ${n} reformulaciones alternativas de la siguiente consulta, usando sinónimos, términos relacionados y distinta redacción, para maximizar el recall.
Devuelve SOLO las reformulaciones, una por línea, sin numerar ni explicar.

Consulta: "${query}"`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 512,
          // Query expansion needs no chain-of-thought; disabling "thinking"
          // avoids the reasoning budget eating the whole token allowance
          // (which truncated the output to MAX_TOKENS) and cuts latency.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return text
      .split('\n')
      .map((l) => l.replace(/^\s*[-*\d.)\s]+/, '').trim())
      .filter((l) => l.length > 1)
      .slice(0, n);
  } catch {
    return []; // network/API failure must never break search
  }
}

// --- fused search over multiple queries ----------------------------------
function searchMany(queries, opts) {
  const chunks = buildCorpus(opts.root);
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const rankings = queries.map((q) => bm25Rank(chunks, tokenize(q)).map((c) => c.id));
  const fused = rrfFuse(rankings);
  return fused
    .map((r) => ({ ...(byId.get(r.id) || { id: r.id }), score: r.score }))
    .slice(0, opts.top);
}

// --- the loop -------------------------------------------------------------
async function thesaurusSearch(query, { top = 10, min = 3, useLlm = true, verbose = false } = {}) {
  const opts = { top, root: process.env.MEMSTACK_ROOT };
  const trace = [];

  // Tier 0 — plain search
  let results = search(query, { top });
  trace.push({ tier: 0, name: 'plain', queries: [query], hits: results.length });
  if (results.length >= min) {
    if (verbose) console.error(JSON.stringify({ tier: 0, hits: results.length }));
    return { results, tier: 0, trace };
  }

  // Tier 1 — local expansion
  const local = localExpansions(query);
  if (local.length) {
    results = searchMany([query, ...local], opts);
    trace.push({ tier: 1, name: 'local', queries: local, hits: results.length });
    if (verbose) console.error(JSON.stringify({ tier: 1, expansions: local, hits: results.length }));
    if (results.length >= min) return { results, tier: 1, trace };
  }

  // Tier 2 — LLM expansion (only if still weak)
  if (useLlm) {
    const llm = await llmExpansions(query);
    if (llm.length) {
      results = searchMany([query, ...local, ...llm], opts);
      trace.push({ tier: 2, name: 'llm', queries: llm, hits: results.length });
      if (verbose) console.error(JSON.stringify({ tier: 2, expansions: llm, hits: results.length }));
      return { results, tier: 2, trace };
    }
  }

  return { results, tier: results.length ? 1 : -1, trace };
}

// --- cli ------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const flags = { top: 10, min: 3, useLlm: true };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') flags.json = true;
    else if (args[i] === '--verbose') flags.verbose = true;
    else if (args[i] === '--no-llm') flags.useLlm = false;
    else if (args[i] === '--top') flags.top = parseInt(args[++i], 10);
    else if (args[i] === '--min') flags.min = parseInt(args[++i], 10);
    else positional.push(args[i]);
  }
  const query = positional.join(' ');
  if (!query) {
    console.log('usage: thesaurus-loop.js "<query>" [--top N] [--min M] [--no-llm] [--json] [--verbose]');
    process.exitCode = 1;
    return;
  }

  const { results, tier, trace } = await thesaurusSearch(query, flags);
  if (flags.json) { console.log(JSON.stringify({ tier, trace, results }, null, 2)); return; }

  const tierName = { '-1': 'no match', 0: 'plain', 1: 'local expansion', 2: 'LLM expansion' }[tier];
  console.log(`# resolved at tier ${tier} (${tierName})`);
  if (!results.length) { console.log('(no matches even after expansion)'); return; }
  for (const r of results) {
    const where = r.heading ? `${r.rel} › ${r.heading}` : (r.rel || '');
    console.log(`[${r.score.toFixed(4)}] ${r.id}`);
    if (r.text) console.log(`  ${r.text}`);
    if (where) console.log(`  ↳ ${where}`);
  }
}

if (require.main === module) main();

module.exports = { thesaurusSearch, localExpansions, llmExpansions };

# layered-memstack

> 📚 OpenClaw skill — 3-layer persistent memory system with automated maintenance.

An opinionated memory architecture for OpenClaw agents: curated core memory (L1), topic files and daily notes (L2), and deep reference docs (L3) — with automated maintenance via Dreaming, deduplication, knowledge graph, and weekly audits.

It stays deliberately thin on retrieval — OpenClaw's `memory_search` already does hybrid keyword+vector ranking, temporal decay, and MMR natively. What the platform *doesn't* ship, and this adds, is a zero-dependency **facts store**: exact, confidence-tracked key-value recall for the things semantic search handles badly (names, settings, IDs). See [Design Notes](#design-notes--what-this-deliberately-does-not-reimplement).

## What It Does

- **Layered memory structure** — L1 (MEMORY.md, always loaded, ~80-110 lines of breadcrumbs), L2 (topic files + daily notes), L3 (deep references, loaded on demand)
- **BOOTSTRAP.md snapshot** — single compiled file replacing 4–6 per-session reads; reduces token cost ~30-50% at session start
- **Nightly consolidation** — via OpenClaw's native Dreaming (2026.4.8+), or a manual cron for older versions
- **Deduplication** — prevents writing the same fact twice using token similarity + entity overlap
- **Knowledge graph** — `reference/entities.md` maps people, places, projects, and their relationships
- **Weekly audit** — cleans expired TTL entries, archives old daily notes, runs dedup, warns if L1 grows too large
- **Pointer integrity check** — deterministic detector for breadcrumbs pointing at files that no longer exist, the one rot an LLM audit reliably misses
- **Cron health digest** — shrinks cron state from ~141 KB to ~1.7 KB so the audit pass that watches your other crons doesn't die of indigestion
- **Temporal decay search** — recent notes rank higher, old notes fade
- **Heartbeat checkpoints** — saves context snapshots when session usage exceeds 50%
- **Facts store** — structured (entity, attribute, value) lookups with a `verified → high_probability → false` confidence ladder, backed by built-in SQLite. Sub-millisecond exact recall for names, settings, and IDs — the one retrieval gap the platform doesn't already fill

---

## Memory Layout

```
workspace/
├── BOOTSTRAP.md          ← compiled snapshot (generated nightly, single read at session start)
├── MEMORY.md             ← L1: breadcrumbs + pointers (~80-110 lines, always loaded)
├── INDEX.md              ← catalog of all files with tags
├── memory/
│   ├── viajes.md         ← L2: topic breadcrumbs
│   ├── salud.md
│   ├── tecnico.md
│   ├── 2026-03-31.md     ← L2: daily notes
│   └── archive/          ← dailies older than 14 days
├── reference/
│   ├── entities.md       ← knowledge graph
│   └── *.md              ← L3: deep dives (loaded on demand)
├── data/
│   └── facts.db                    ← structured facts store (SQLite, gitignored)
└── scripts/
    ├── build-bootstrap.js           ← compiles BOOTSTRAP.md from memory files
    ├── memory-compact-promoted.js   ← prunes Dreaming-promoted duplicates from MEMORY.md
    ├── memory-dedup.js              ← dedup engine
    ├── memory-check-pointers.js     ← broken-pointer detector (live memory only)
    ├── cron-health.js               ← pre-digests cron state for the audit pass
    └── facts-store.js               ← structured KV facts with confidence ladder
```

---

## The Three Layers

### L1 — Core Memory (MEMORY.md)

Always loaded at session start. Contains **breadcrumbs and pointers only** — not detailed information. Each section points to the relevant L2/L3 file.

> **💡 Why ~80-110 lines?** MEMORY.md is injected as context on every turn, so its cost scales directly with its length. Measured on a real workspace at ~110 bytes/line: 60 lines ≈ 1.7K tokens/turn, 110 lines ≈ 3.0K. Treat the range as a token budget, not a style rule.
>
> **Revised from ~50-60 (2026-08).** The original target was tighter, but in day-to-day use with ~10 active domains (travel, health, finances, pets, side projects) it was missed every single week — the legitimate breadcrumbs simply didn't fit. A target that's permanently violated stops being a signal: the weekly audit flagged it every run with nothing actionable to do. 80-110 is the honest ceiling. Past 110, don't compress the wording — move detail down to L2/L3, which is what the layers are for.

TTL support for time-bound items:

```markdown
- Renew TLS certificate <!-- ttl:2026-05-01 -->
```

TTLs are cleaned automatically by the weekly audit cron.

### L2 — Topic Files & Daily Notes

Topic files (`memory/viajes.md`, `memory/salud.md`) hold mid-level context organized by subject. Daily notes contain decisions, actions, preferences, pending items, and atomic facts.

### L3 — Deep References

Detailed docs (`reference/china_2026.md`, `reference/integraciones.md`) only loaded when search finds them relevant.

#### Compress-on-completion pattern

When a long-running L3 doc closes (a trip ends, a project ships, an investigation wraps), the operational detail stops being read but the references (booking codes, IDs, lessons, pending refunds) still matter.

Instead of deleting or shrinking the doc in place, split it in two:

- `reference/archive/<topic>.md` — compressed summary (~2–4 KB): key refs, totals, lessons, outstanding items. This is what `memory_search` surfaces and what humans skim.
- `reference/archive/<topic>_full.md` — original verbatim, preserved. Linked from the summary header (`Detalle completo → ...`).

Net effect: searches and loads hit ~4 KB instead of ~20 KB, with **zero data loss** — the full doc is still on disk, still indexed, still recoverable for refund arguments, rebooks, or forensic questions months later.

Rule of thumb: apply when the doc is ≥ 10 KB, has been read-only for ≥ 2 weeks, and represents a closed event. The optional analytical audit (see [Automated Maintenance](#automated-maintenance)) is a natural place to flag candidates.

---

## BOOTSTRAP.md — Session Cost Optimization

`BOOTSTRAP.md` is a **compiled snapshot** that replaces reading 4–6 separate memory files at session start. One read instead of many.

### What it contains

- `MEMORY.md` curated facts (truncated ~2000 chars)
- Daily notes: today + yesterday (~1500 chars each)
- Topic summaries: `memory/viajes.md`, `memory/salud.md`, `memory/tecnico.md` (~800 chars each)
- Upcoming trips: first 60 lines of `reference/viajes-kayak.md`
- Recent health data: last 15 lines of `reference/salud-datos.md`

**Typical size:** ~8KB vs ~40-80KB reading files individually.

### Generate

```bash
node scripts/build-bootstrap.js
```

### Nightly cron (2:50 AM)

```json
{
  "name": "Build BOOTSTRAP.md",
  "schedule": { "kind": "cron", "expr": "50 2 * * *", "tz": "Europe/Madrid" },
  "payload": {
    "kind": "agentTurn",
    "model": "haiku",  // or any fast/cheap model alias
    "message": "Ejecuta: node /path/to/scripts/build-bootstrap.js\nResponde siempre: OK"
  }
}
```

---

## Knowledge Graph

`reference/entities.md` — a lightweight, markdown-based entity index mapping people, places, companies, projects, trips, and devices with their relationships.

```markdown
## Personas
- **Maria López** | Backend lead @ Acme Corp | Slack: @maria | relevant: api-migration

## Empresas
- **Acme Corp** | SaaS platform, B2B | HQ: Madrid | contacts: Maria López (tech)

## Proyectos
- **api-migration** | REST→GraphQL | status: active | lead: Maria López

## Viajes
- **Tokyo Nov 2026** | 15-22 Nov | flights: IB6801/IB6802 | hotel: Park Hyatt
```

**Maintained by:** Dreaming (nightly), manual edits, weekly audit cleanup.

**Used when:** resolving ambiguous names, getting project context without loading full docs, connecting dots across topics.

---

## Deduplication

Before writing to MEMORY.md, always check for similar existing content:

```bash
# Check single line (exit 0 = duplicate → skip, exit 1 = new → safe to add)
node scripts/memory-dedup.js --query "GitHub configured with gh auth login"

# After any write, clean the file
node scripts/memory-dedup.js --fix

# Inspect what would be removed (read-only)
node scripts/memory-dedup.js --check

# Batch query: filter lines from a file
node scripts/memory-dedup.js --query-batch /tmp/candidates.txt
```

Algorithm: Jaccard similarity + containment ratio + entity overlap (dates, IDs, versions, URLs). Threshold: 0.65 (configurable via `--threshold`).

> **Note (OpenClaw 2026.4.8+):** Dreaming injects `<!-- openclaw-memory-promotion:... -->` provenance markers into MEMORY.md. The dedup engine automatically skips these lines to avoid false positives (fixed in `fd389b9`).

### Suppressing false positives

Semantic matches are heuristic, so `--fix` occasionally flags two lines that read alike but mean different things — a classic case is an open TODO sitting next to the already-settled decision on the same topic:

```markdown
- Claude Desktop on laptop: use mcp-proxy.js
- [ ] Configure mcp-proxy.js on laptop (Tailscale MagicDNS) <!-- dedup:ignore -->
```

Add `<!-- dedup:ignore -->` to exclude a line from the analysis. Without it `--fix` re-marks the same line on every run, and a marker that always fires stops being a signal. The marker is stripped before scoring, so it never affects similarity itself.

Mirrors the `<!-- pointer-check:ignore -->` convention used by the pointer checker.

---

## Pointer Integrity

A layered memory system is held together by pointers: L1 points to L2, L2 points to L3, INDEX.md points at everything. Rename, archive or compress a file and the pointers to it rot silently — and a rotten pointer is worse than a missing note, because recall surfaces a breadcrumb that leads nowhere and the agent confidently reports "detail in `reference/foo.md`" for a file that no longer exists.

```bash
node scripts/memory-check-pointers.js          # human report, exit 1 if broken
node scripts/memory-check-pointers.js --quiet  # one line per break (for crons)
node scripts/memory-check-pointers.js --json   # machine-readable
```

It scans **live memory only** — root files (`MEMORY.md`, `AGENTS.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `INDEX.md`), `memory/*.md` and `reference/*.md`, no recursion. Archived notes legitimately point at files that were later moved, so flagging them produces noise instead of debt. Mark example paths in prose with `<!-- pointer-check:ignore -->`.

**Why a script and not a prompt.** The direction of the check is what matters. An LLM audit asking "are there files with no pointer?" finds orphans; it does *not* find pointers with no file, and that is the harmful direction. Real case (2026-08-03): a weekly memory-audit cron reported OK for weeks while two dead pointers sat in a topic file, because it only checked the opposite direction. This runs in ~50 ms and gives a cron an exit code to branch on. It's step 1 of the mechanical weekly audit, with instructions to re-run until it exits 0.

---

## Cron Health — the watchdog paradox

If you run an "audit my crons" cron, do **not** let the model list the crons itself. Handing it raw `openclaw cron list --all --json` means feeding it every job object you own — prompts, schedules, run history. Measured on a real install: 51 jobs → **141,563 bytes**, runs burning 250–630k tokens and failing ~40% of the time with a generic timeout.

That failure is self-concealing: the watchdog is the thing that reports *other* crons failing, so when it dies of indigestion, nothing reports anything — including the memory audit that had been quietly skipping broken pointers for weeks. One clogged watchdog explains a whole system rotting unnoticed.

```bash
node scripts/cron-health.js          # compact text report
node scripts/cron-health.js --json   # compact JSON
# exit 0 = clean · 1 = jobs in error · 2 = gateway unreadable
```

It reads live gateway state and keeps only the actionable part: jobs in error (with model + timeout), persistent failures (≥2 consecutive — structural, not a provider hiccup), undelivered runs, enabled recurring jobs that never ran, and `agentTurn` jobs with no `timeoutSeconds`.

| | Before | After |
|---|---|---|
| Input to the model | 141 KB | 1.7 KB (−98.8%) |
| Audit run | error, 390k tokens, not delivered | ok, 174k tokens, 44 s, delivered |

Three rules this encodes:

- **Run the script, and forbid manual listing in the prompt — with the reason.** A model that finds the digest terse will "helpfully" fall back to the raw dump and reintroduce the bug.
- **Always set `timeoutSeconds` on `agentTurn` crons.** No limit doesn't mean fails fast; it means fails silently and expensively. The digest counts these for you.
- **Never enumerate jobs via the in-agent cron tool from inside a cron.** On isolated cron sessions the narrow self-cleanup grant filters the response to the current job, so the audit sees only itself and reports all-clear.

---

## Facts Store

Semantic search is the wrong tool for "what's my API key?" or "which timezone is alice in?" — those are exact key-value lookups, not similarity problems. `facts-store.js` stores **(entity, attribute, value)** triples in built-in SQLite with a three-state **confidence ladder**:

```
verified  →  high_probability  →  false
```

New evidence reconciles automatically: same value promotes confidence; a higher-confidence contradiction replaces; a lower-confidence one is **rejected with a conflict warning** rather than silently dropped.

```bash
node scripts/facts-store.js save alice timezone "Europe/Madrid" --confidence verified --source USER.md
node scripts/facts-store.js get alice timezone
node scripts/facts-store.js query --entity alice
node scripts/facts-store.js demote alice timezone        # mark wrong without a replacement
```

Reads are sub-millisecond. The ladder means the store sharpens over time instead of accumulating stale guesses. The DB lives at `data/facts.db` (gitignored).

---

## Design Notes — What This Deliberately Does *Not* Reimplement

This skill is intentionally thin. OpenClaw's runtime already does the heavy retrieval work well, so layered-memstack stays out of its way and only adds what the platform doesn't ship. If you're evaluating this, know where the line is:

| Capability | Handled by | Don't reimplement |
|---|---|---|
| **Hybrid keyword + vector search** | Native `memory_search` (`query.hybrid`: `vectorWeight`/`textWeight`, `candidateMultiplier`) | Configure the weights; the lexical half is built in |
| **Temporal decay ranking** | Native `memory_search` (`query.hybrid.temporalDecay`) | Set `halfLifeDays` |
| **MMR diversity** | Native `memory_search` (`query.hybrid.mmr`) | Set `lambda` |
| **Query expansion / reranking** | The optional [QMD sidecar](https://docs.openclaw.ai/concepts/memory-qmd) (BM25 + vectors + reranking + expansion) | Enable QMD if you want it |
| **Wikilink & provenance linting** | The [`memory-wiki`](https://docs.openclaw.ai/plugins/memory-wiki) plugin's `wiki_lint` (structural checks, provenance gaps, contradictions) | Run `wiki_lint` |

**What's actually missing from the platform — and therefore lives here — is the [facts store](#facts-store):** exact, confidence-tracked key-value recall. Everything else in this repo is memory *structure* and *maintenance* (layers, BOOTSTRAP, dedup, dreaming, audits), not retrieval — because retrieval is already solved upstream.

> Earlier iterations shipped standalone BM25 search, an escalation-only thesaurus loop, and a wikilink validator. They were removed once it was clear the runtime covers all three natively — kept in git history if you want the reference implementations.

---

## Automated Maintenance

| What | When | How |
|---|---|---|
| **BOOTSTRAP.md build** | 2:50 AM daily | Cron — compiles snapshot from all memory files |
| **Nightly consolidation** | 3:00 AM daily | Dreaming (native OpenClaw 2026.4.8+) — multi-phase sweep with built-in dedup |
| **Compact promoted blocks** | 3:15 AM daily | Cron — prunes duplicates Dreaming promoted into MEMORY.md (see below) |
| **Weekly audit (mechanical)** | Monday 3:40 AM | Cron — pointer check, archives old dailies, cleans TTLs, dedup, size check |
| **Weekly audit (analytical)** | Sunday 22:00 — *optional* | Cron — inventory + structural drift + compress-on-completion candidates |
| **MCP audit** (optional) | 11:00 PM daily | Cron — reviews external MCP writes for suspicious content |
| **Heartbeat checkpoint** | On context threshold | Silent save at 50–79%; full save + alert at ≥80% |

---

## Dreaming (OpenClaw 2026.4.8+)

Dreaming replaces the manual 3 AM auto-summary cron. It runs a multi-phase consolidation sweep (light → REM → deep) directly against the memory index — no prompt engineering, zero maintenance.

| | Manual cron (old) | Dreaming (native) |
|---|---|---|
| Consolidation | Agent reads transcripts + writes markdown | Runtime processes memory index directly |
| MEMORY.md updates | Agent edits file | Handled by deep phase |
| Dedup | Separate cron | Built-in |
| Maintenance | Prompt engineering required | Zero-maintenance |

### Enable Dreaming

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true,
            "frequency": "0 3 * * *",
            "timezone": "Europe/Madrid"
          }
        }
      }
    }
  }
}
```

Once enabled, delete any manual auto-summary and dedup crons — Dreaming handles both.

### The Dreaming promotion problem (and the fix)

Dreaming injects high-score blocks from `memory/archive/YYYY-MM-DD.md` directly into MEMORY.md with provenance markers:

```markdown
<!-- openclaw-memory-promotion:memory:memory/archive/2026-03-09.md:22:48 -->
- [1500 chars of original daily note content pasted verbatim...]
```

The **content is duplicated** — it still lives in the archive file, `memory_search` still finds it — but MEMORY.md grows by 500-1500 chars per promotion. After a few weeks of Dreaming runs, MEMORY.md balloons beyond the bootstrap injection limit (~12KB default), partially defeating the point of keeping L1 compact.

**Fix:** `scripts/memory-compact-promoted.js` — runs daily at 3:15 AM (right after Dreaming finishes). For each promoted block older than 2 days, it verifies the source archive file still exists, then replaces the full block with a one-line reference stub:

```markdown
<!-- openclaw-memory-promotion:memory:memory/archive/2026-03-09.md:22:48 --> <!-- compacted:2026-05-04 -->
- `memory/archive/2026-03-09.md` lines 22-48 (compacted 2026-05-04; search with memory_search or read archive)
```

No data is lost — the original content remains in the archive file and stays searchable. The script is idempotent (already-compacted blocks are skipped) and takes a backup (`MEMORY.md.bak-<timestamp>`) before mutating.

```bash
node scripts/memory-compact-promoted.js                   # apply
node scripts/memory-compact-promoted.js --dry             # preview
node scripts/memory-compact-promoted.js --min-age-days=0  # compact all (including today's)
node scripts/memory-compact-promoted.js --workspace=/path # override workspace root
```

`setup-crons.sh` installs the daily cron automatically.

---

## Heartbeat Checkpoints

Configure in HEARTBEAT.md (not a separate cron). Check context usage via `session_status` on every heartbeat:

| Usage | Action |
|-------|--------|
| < 50% | No action |
| 50–79% | **Silent checkpoint** — append `## Checkpoint [HH:MM]` to `memory/YYYY-MM-DD.md` with decisions, pending tasks, key facts. Do not alert the user. |
| ≥ 80% | **Full checkpoint** — save everything + alert user to consider `/new` |

This ensures nothing is lost before context compaction, without spamming the user.

---

## Weekly Audit Cron

Schedule: `0 3 * * 1` (Monday 3:00 AM, your timezone). Session: isolated agentTurn.

The audit prompt should instruct the agent to run these steps in order:

1. **Archive old dailies** — move `memory/YYYY-MM-DD.md` files older than 14 days to `memory/archive/`
2. **Clean expired TTLs** — remove lines from MEMORY.md where `<!-- ttl:YYYY-MM-DD -->` date has passed
3. **Run dedup** — `node scripts/memory-dedup.js --fix`
4. **Check L1 size** — `wc -l MEMORY.md` — warn if > 70 lines (detail should move to reference/)
5. **Report** — send summary of changes; stay silent if nothing to do

Use a small/cheap model (e.g. Haiku). This pass is mechanical: no judgment calls, just rules.

### Optional: Analytical audit (Sunday 22:00)

The mechanical audit above ships fixes but doesn't propose structural changes. A complementary weekly pass with a stronger model surfaces things the mechanical pass can't:

- Files growing past comfort thresholds (e.g. >8 KB in `reference/`) that may need splitting or compressing
- Orphan references (files with no pointer in MEMORY.md or INDEX.md)
- Topic blocks in MEMORY.md dense enough to deserve their own `memory/<topic>.md` breadcrumb
- L3 docs eligible for the **compress-on-completion** pattern (closed trips/projects)
- INDEX.md drift vs actual filesystem state

Schedule: `0 22 * * 0` (Sunday 22:00 local time). Session: isolated agentTurn. Model: a stronger reasoning model (Opus / Sonnet / Gemini Pro).

Prompt structure:

1. **Inventory** — list `memory/` and `reference/` with sizes; read MEMORY.md; `wc -l` and `du -sh`.
2. **Analyze** — flag oversized files, orphan refs, dailies >14d, MEMORY.md size target, topic-block candidates, structural drift, INDEX.md coherence.
3. **Auto-apply safe fixes only** — expired TTLs, archiving stale dailies, INDEX.md sync.
4. **Propose (do not execute)** — anything destructive or structural: file deletions, splits, breadcrumb extraction, compress-on-completion candidates.
5. **Report** — single summary to the user (and/or a logs channel) with applied actions and proposals.

The two audits are complementary, not redundant:

| | Mechanical (Mon 03:00) | Analytical (Sun 22:00) |
|---|---|---|
| **Cost** | Cheap (Haiku class) | Higher (Opus/Sonnet class) |
| **Behavior** | Executes deterministic rules | Reads, judges, proposes |
| **Output** | Silent unless changes | Always reports inventory + suggestions |
| **When** | Start of week | End of week / Sunday review |

Skip this cron if token budget matters more than structural drift. Keep it if your memory system grows organically and you want a weekly second opinion that catches what rule-based passes miss.

---

## Memory Wiki (OpenClaw 2026.4.8+)

memory-wiki compiles the 3-layer structure into a navigable wiki with:

- **Structured claims** with confidence scores and source provenance
- **Contradiction detection** — flags conflicting data across notes
- **Staleness dashboards** — surfaces outdated data
- **Wiki-native tools** — `wiki_search`, `wiki_get`, `wiki_apply`, `wiki_lint`

### Enable Memory Wiki

```json
{
  "plugins": {
    "entries": {
      "memory-wiki": {
        "enabled": true,
        "config": {
          "vaultMode": "unsafe-local",
          "unsafeLocal": {
            "allowPrivateMemoryCoreAccess": true,
            "paths": [
              "/path/to/workspace/MEMORY.md",
              "/path/to/workspace/memory/",
              "/path/to/workspace/reference/",
              "/path/to/workspace/projects/"
            ]
          },
          "search": { "backend": "shared", "corpus": "all" }
        }
      }
    }
  }
}
```

Then: `openclaw wiki compile`

Reads your existing files directly — nothing to migrate.

---

## Installation

> **Requirements:** Node **≥ 22.5** if you use the facts store (it relies on the built-in `node:sqlite` module — no native builds, no external packages). Everything else is plain markdown + Node with zero dependencies.

> **Note:** Not yet published on ClawHub. Install from GitHub.

```bash
git clone https://github.com/emiliotorrens/layered-memstack.git
```

Or as a local skill in `openclaw.json`:

```json5
{
  "skills": {
    "local": {
      "paths": ["/path/to/layered-memstack"]
    }
  }
}
```

### Setup steps

1. Create the directory structure: `mkdir -p memory/archive reference scripts data`
2. Copy the `scripts/` files to your workspace `scripts/` (`memory-dedup.js`, `build-bootstrap.js`, `memory-compact-promoted.js`, and — optionally — `facts-store.js`)
3. Configure `memorySearch.extraPaths` (see Configuration below)
4. Enable Dreaming (see above)
5. Run `bash scripts/setup-crons.sh` for the weekly audit and BOOTSTRAP crons

```bash
bash scripts/setup-crons.sh --tz Europe/Madrid --channel telegram --to "CHAT_ID"
# Add --mcp-audit if using mem-persistence MCP server
# Add --dry-run to preview without creating
```

---

## Configuration

Add to `agents.defaults.memorySearch` in `openclaw.json`:

```json5
{
  "extraPaths": ["MEMORY.md", "USER.md", "IDENTITY.md", "memory/", "reference/", "projects/"],
  "sources": ["memory", "sessions"],
  "query": {
    "hybrid": {
      "mmr": { "enabled": true, "lambda": 0.7 },
      "temporalDecay": { "enabled": true, "halfLifeDays": 30 }
    }
  }
}
```

### Embedding provider — local (recommended) vs cloud

`memory_search` needs an embedding provider. **Local is recommended**, for two reasons learned in production:

- **Robustness** — cloud providers (Gemini/OpenAI/Voyage) hit quota limits (HTTP 429) and can drift on config updates, pausing semantic search until you rebuild. Local depends on nobody.
- **Privacy** — with cloud, every memory chunk (health, finances, family) is sent to the provider's API to be embedded. With local, **memory never leaves the server** — the right default for a personal 24/7 assistant holding sensitive data.

The only trade-off is retrieval quality (local EmbeddingGemma = 768 dims vs Gemini's 3072), which is marginal for a personal corpus of a few thousand notes, at the cost of one always-on service (~600 MB–1 GB RAM).

Both paths are supported — pick based on your resources.

**Option A — Local (Ollama + EmbeddingGemma 300M) — recommended.** Install Ollama in user space, run it as a `systemd --user` service (survives reboots with linger enabled), then `ollama pull embeddinggemma` (621 MB · 768 dims · multilingual). In `openclaw.json`, declare the provider and point `memorySearch` at it:

```json5
{
  "models": { "providers": { "ollama-local": {
    "api": "ollama",
    "baseUrl": "http://127.0.0.1:11434",
    "apiKey": "ollama-local",
    "models": [{ "id": "embeddinggemma", "name": "EmbeddingGemma 300M (local)" }]
  } } },
  "agents": { "defaults": { "memorySearch": { "provider": "ollama-local", "model": "embeddinggemma" } } }
}
```

**Option B — Cloud (Gemini / OpenAI / Voyage) — zero setup.** If you can't spare the RAM/disk for a local model, or would rather not run an extra service, use a hosted provider instead. No install, and slightly higher retrieval quality (e.g. Gemini = 3072 dims) — at the cost of provider quotas (HTTP 429) and sending each chunk to the provider's API. Point `memorySearch` at the provider and supply the matching API key (e.g. `GEMINI_API_KEY`):

```json5
{ "agents": { "defaults": { "memorySearch": { "provider": "gemini", "model": "gemini-embedding-001" } } } }
```

After any provider change, rebuild the index with `openclaw memory index --force`, then verify with `openclaw memory status --deep` (expect `Vector store: ready` and the new `Vector dims`).

### Recommended AGENTS.md additions

```markdown
## Every Session
1. Read `BOOTSTRAP.md` — compiled snapshot (replaces reading multiple memory files).
   Fallback if missing or stale (>24h): read `memory/YYYY-MM-DD.md` (today + yesterday).
2. Read `SOUL.md` and `USER.md`
3. Use `memory_search` for anything beyond recent context

## Memory Rules
- MEMORY.md = breadcrumbs + pointers only. Detail goes in reference/ or memory/.
- Before writing to MEMORY.md: `node scripts/memory-dedup.js --query "text"` (exit 0 = dup, skip; exit 1 = new, ok)
- After writing to MEMORY.md: `node scripts/memory-dedup.js --fix`
- Time-bound items: add `<!-- ttl:YYYY-MM-DD -->` — cleaned by weekly audit
```

---

## Token Efficiency

All workspace files are injected into every turn as context. This skill minimizes that cost:

- **L1 stays bounded** (~80-110 lines) — breadcrumbs only, never detail
- **Detail lives in L2/L3** — loaded on demand via `memory_search`
- **Automated maintenance** prevents MEMORY.md from growing back
- **Real-world savings**: ~56% reduction in workspace injection tokens (from ~6K to ~2.7K tokens/turn), measured with L1 at ~60 lines. At the revised 80-110 ceiling, budget roughly ~1.4K tokens/turn more for L1 — still a large net win, since the bulk of the saving comes from the BOOTSTRAP.md snapshot and from keeping detail out of L1, not from the line cap itself.

---

## Related

- **[mem-persistence](https://github.com/emiliotorrens/mem-persistence)** — MCP server to share this memory with Claude Desktop, Claude Code, Cursor, and other agents
- **[memory-wiki](https://github.com/openclaw/openclaw)** — bundled OpenClaw plugin for structured wiki with claims, contradictions, and dashboards

## Inspiration & Credits

- **[OpenClaw community — layered memory post](https://www.reddit.com/r/openclaw/comments/1rnku5b/)** — the L1/L2/L3 architecture that inspired this
- **[Signet AI](https://github.com/Signet-AI/signetai)** — knowledge graph inspiration
- **[mnemo-cortex](https://github.com/GuyMannDude/mnemo-cortex)** — the facts store with a confidence ladder
- **[OpenClaw](https://github.com/openclaw/openclaw)** — the agent framework this was built for
- **[Mario Andújar](https://github.com/marioandujar)** — local embeddings setup (Ollama + EmbeddingGemma) for private, quota-free memory search

## Roadmap

- [x] 3-layer memory structure
- [x] Deduplication engine
- [x] Knowledge graph
- [x] Weekly audit with TTL cleanup, dedup, and size check
- [x] Dreaming integration (OpenClaw 2026.4.8+)
- [x] BOOTSTRAP.md compiled snapshot
- [x] Heartbeat checkpoints (50/80% thresholds)
- [x] memory-wiki integration (unsafe-local mode)
- [x] Daily compact of Dreaming-promoted blocks (prevents L1 bloat)
- [x] Facts store (SQLite KV + confidence ladder)
- [x] Deterministic pointer-integrity check (`memory-check-pointers.js`)
- [x] Cron health digest to keep the audit watchdog from clogging (`cron-health.js`)
- [ ] Expose the facts store as a callable tool (via the mem-persistence MCP bridge)
- [ ] Category classification of notes at write time
- [ ] Publish to ClawHub
- [ ] Interactive setup wizard
- [ ] Migration tool for existing setups

## License

MIT

---

Built with 🐾 by [Emilio Torrens](https://github.com/emiliotorrens) and [Claw](https://github.com/openclaw/openclaw).

# layered-memstack

> 📚 OpenClaw skill — 3-layer persistent memory system with automated maintenance.

An opinionated memory architecture for OpenClaw agents: curated core memory (L1), topic files and daily notes (L2), and deep reference docs (L3) — with automated maintenance via Dreaming, deduplication, knowledge graph, and weekly audits.

## What It Does

- **Layered memory structure** — L1 (MEMORY.md, always loaded, ~50-60 lines of breadcrumbs), L2 (topic files + daily notes), L3 (deep references, loaded on demand)
- **BOOTSTRAP.md snapshot** — single compiled file replacing 4–6 per-session reads; reduces token cost ~30-50% at session start
- **Nightly consolidation** — via OpenClaw's native Dreaming (2026.4.8+), or a manual cron for older versions
- **Deduplication** — prevents writing the same fact twice using token similarity + entity overlap
- **Knowledge graph** — `reference/entities.md` maps people, places, projects, and their relationships
- **Weekly audit** — cleans expired TTL entries, archives old daily notes, verifies INDEX.md
- **Temporal decay search** — recent notes rank higher, old notes fade
- **Heartbeat checkpoints** — saves context snapshots when session usage is high

---

## Memory Layout

```
workspace/
├── BOOTSTRAP.md          ← compiled snapshot (generated nightly, single read at session start)
├── MEMORY.md              ← L1: breadcrumbs + pointers (~50-60 lines, always loaded)
├── INDEX.md               ← catalog of all files with tags
├── memory/
│   ├── viajes.md          ← L2: topic breadcrumbs
│   ├── salud.md
│   ├── tecnico.md
│   ├── 2026-03-31.md      ← L2: daily notes
│   └── archive/           ← dailies older than 14 days
├── reference/
│   ├── entities.md        ← knowledge graph
│   └── *.md               ← L3: deep dives (loaded on demand)
└── scripts/
    ├── build-bootstrap.js ← compiles BOOTSTRAP.md from memory files
    └── memory-dedup.js    ← dedup engine
```

---

## The Three Layers

### L1 — Core Memory (MEMORY.md)

Always loaded at session start. Contains **breadcrumbs and pointers only** — not detailed information. Each section points to the relevant L2/L3 file.

> **💡 Why ~50-60 lines?** MEMORY.md is injected as context on every turn. Keeping it compact saves ~56% of workspace injection tokens compared to ~100 lines — that adds up across hundreds of daily turns.

TTL support for time-bound items:

```markdown
- Cancel Fitbit Premium <!-- ttl:2026-05-01 -->
```

### L2 — Topic Files & Daily Notes

Topic files (`memory/viajes.md`, `memory/salud.md`) hold mid-level context organized by subject. Daily notes contain decisions, actions, preferences, pending items, and atomic facts.

### L3 — Deep References

Detailed docs (`reference/china_2026.md`, `reference/integraciones.md`) only loaded when search finds them relevant.

---

## BOOTSTRAP.md — Session Cost Optimization

`BOOTSTRAP.md` is a **compiled snapshot** that replaces reading 4–6 separate memory files at session start. One read instead of many.

### What it contains

- `MEMORY.md` curated facts (truncated ~2000 chars)
- Daily notes: today + yesterday (~1500 chars each)
- Topic summaries: `memory/viajes.md`, `memory/salud.md`, `memory/tecnico.md` (~800 chars each)
- Upcoming trips: first 60 lines of `reference/viajes-kayak.md`
- Recent health data: last 15 lines of `reference/salud-datos.md`

**Typical size:** ~8KB. vs ~40-80KB reading files individually.

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
    "model": "google/gemini-2.5-flash",
    "message": "Ejecuta: node /path/to/scripts/build-bootstrap.js\nResponde siempre: OK"
  }
}
```

### AGENTS.md setup

```markdown
## Every Session
1. Read `BOOTSTRAP.md` — compiled snapshot (replaces reading multiple memory files)
   - Fallback if missing/stale (>24h): read `memory/YYYY-MM-DD.md` (today + yesterday)
2. Read `SOUL.md` and `USER.md`
3. Use `memory_search` for anything beyond recent context
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

Before writing to MEMORY.md, check for similar existing content:

```bash
# Check single line (exit 0 = duplicate, exit 1 = new)
node scripts/memory-dedup.js --query "GitHub configured with gh auth login"

# Check batch
node scripts/memory-dedup.js --query-batch /tmp/candidates.txt

# Clean existing file
node scripts/memory-dedup.js --fix
```

Algorithm: Jaccard similarity + containment ratio + entity overlap (dates, IDs, versions, URLs). Threshold: 0.65 (configurable via `--threshold`).

---

## Automated Maintenance

| What | When | How |
|---|---|---|
| **Nightly consolidation** | 3:00 AM | Dreaming (native OpenClaw 2026.4.8+) — multi-phase sweep with built-in dedup |
| **Weekly audit** | Sunday 22:00 | Cron — cleans TTLs, archives old dailies, verifies INDEX.md |
| **MCP audit** (optional) | 11:00 PM | Cron — reviews external MCP writes for suspicious content |
| **Heartbeat checkpoint** | Every ≤4h | Saves context if session usage >50% |

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

1. Create the directory structure (`mkdir -p memory/archive reference scripts`)
2. Copy `scripts/memory-dedup.js` to your workspace
3. Configure `memorySearch.extraPaths` (see below)
4. Enable Dreaming (see above)
5. Run `bash scripts/setup-crons.sh` for the weekly audit cron

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

### Recommended AGENTS.md additions

```markdown
## Memory
1. Read `MEMORY.md` at session start (breadcrumbs + pointers, ~50-60 lines)
2. Read `memory/YYYY-MM-DD.md` for today + yesterday
3. Use `memory_search` for anything beyond recent context
4. MEMORY.md = pointers only. Detail goes in reference/ or memory/.
5. Update MEMORY.md only for genuinely new long-term facts
```

---

## Token Efficiency

All workspace files are injected into every turn as context. This skill minimizes that cost:

- **L1 stays tiny** (~50-60 lines) — breadcrumbs only, never detail
- **Detail lives in L2/L3** — loaded on demand via `memory_search`
- **Automated maintenance** prevents MEMORY.md from growing back
- **Real-world savings**: ~56% reduction in workspace injection tokens (from ~6K to ~2.7K tokens/turn)

---

## Active Memory: How layered-memstack Powers OpenClaw

`layered-memstack` doesn't just organize memory; it serves as the fundamental engine for OpenClaw's "Active Memory." This architecture enables the agent to:

- **Proactive Context Retrieval**: Utilizes `memory_search` to access L2 and L3 information only when relevant, keeping the core context (L1) light and efficient.
- **Intelligent Consolidation**: Through integration with `Dreaming`, the knowledge base is automatically consolidated and pruned nightly, ensuring information is always fresh and free of duplicates.
- **Coherence and Verification**: Integration with `memory-wiki` allows for structuring claims, detecting contradictions, and verifying data validity, building a more robust and reliable knowledge base.
- **Continuous Evolution**: The system is designed so that memory not only stores data but also evolves and adapts to the agent's new interactions and learnings.

In essence, `layered-memstack` transforms static memory into a dynamic and proactive system, optimizing the agent's performance and responsiveness.

---

## Related

- **[mem-persistence](https://github.com/emiliotorrens/mem-persistence)** — MCP server to share this memory with Claude Desktop, Claude Code, Cursor, and other agents
- **[memory-wiki](https://github.com/openclaw/openclaw)** — bundled OpenClaw plugin for structured wiki with claims, contradictions, and dashboards

## Inspiration & Credits

- **[OpenClaw community — layered memory post](https://www.reddit.com/r/openclaw/comments/1rnku5b/)** — the L1/L2/L3 architecture that inspired this
- **[Signet AI](https://github.com/Signet-AI/signetai)** — knowledge graph inspiration
- **[OpenClaw](https://github.com/openclaw/openclaw)** — the agent framework this was built for

## Roadmap

- [x] 3-layer memory structure
- [x] Deduplication engine
- [x] Knowledge graph
- [x] Weekly audit and TTL cleanup
- [x] Dreaming integration (OpenClaw 2026.4.8+)
- [x] memory-wiki integration (unsafe-local mode)
- [ ] Publish to ClawHub
- [ ] Interactive setup wizard
- [ ] Migration tool for existing setups

## License

MIT

---

Built with 🐾 by [Emilio Torrens](https://github.com/emiliotorrens) and [Claw](https://github.com/openclaw/openclaw).

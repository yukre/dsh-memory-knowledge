# dsh-memory-knowledge

Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai). Plain Markdown memories organized in a folder tree, linked by a relation graph, curated every night by DSH's own agent. Answers that use a memory cite it with a clickable link.

只记想明白的结论；错的、旧的能自动和手动改掉，而且改完不会被覆盖回去；尽量少花 token。

## What it does

| | |
|---|---|
| **Remember only what was worked out** | Nothing is written during a conversation except what you explicitly ask to keep. Every night a curator agent reads new conversations and writes conclusions through a checklist (claim / why / scope / when to use) and a deterministic gate: evidence must exist verbatim, transcription is refused, near-duplicates need an explicit resolution. New knowledge waits in a staging pool until it is cited in other sessions without objection. |
| **Fix what is wrong or stale** | "That's wrong / outdated / forget it" in a conversation marks or retires the item. A newer conclusion supersedes an older one (the old one is archived with a tombstone so old evidence cannot bring it back). Editing a file by hand is detected by fingerprint, diffed, processed first at night, and protected: the machine never rewrites a hand-edited item without newer words from you. Every change is in a changelog with undo. |
| **Save tokens** | The session snapshot (rules, categories, core preferences) is computed once per session and never changes inside it, so it stays in the provider's prompt cache. Everything else is fetched on demand by `mk_recall`: at most 5 snippets of 400 characters, related items as titles only. |

## Install

Plugins → Add plugin → `github:yukre/dsh-memory-knowledge#<commit>`.

On first start it creates `~/.dsh/memory-knowledge/` and a nightly task "记忆知识库整理" (00:30, local time). The task is repaired automatically if it is deleted or edited; your own time and pause settings are kept.

## Layout

```
~/.dsh/memory-knowledge/
├── library/                 ← the knowledge base: plain Markdown, edit freely
│   ├── <category>/*.md      ← memories (category README.md tables are generated)
│   ├── 偏好/                 ← core preferences, shown in every session
│   ├── skills/<name>/SKILL.md
│   ├── _staging/            ← waiting for validation
│   └── _archive/            ← retired, superseded, expired
├── workspace/               ← where curator sessions run
└── meta/
    ├── changelog.jsonl      ← every change, append-only
    ├── history/<id>/*.md.gz ← every version (diff baseline and undo)
    └── graph.sqlite         ← pools, relations, votes, tombstones (rebuildable)
```

Each memory ends with an identity line `<!-- dmk:id=mk_… -->`. Renames, moves and edits keep it; copies get a new one; a deleted line is restored after the file has been quiet for a minute.

## Tools

| Who | Tools |
|---|---|
| Every session | `mk_recall` (query / browse / open), `mk_remember`, `mk_feedback` (wrong / outdated / forget / confirm) |
| Curator sessions only | `mk_next`, `mk_excerpt`, `mk_write`, `mk_done`, `mk_import`, `mk_undo`, `mk_status` (+ read-only `read`, `glob`, `grep`) |

## Settings

Left sidebar → 记忆知识库 → 设置, or the plugin row's config. Every field has a default.

| Field | Default | Meaning |
|---|---|---|
| `memoryRoot` | `~/.dsh/memory-knowledge` | data root |
| `injectTag` | `dmk` | tag wrapping the snapshot |
| `curator.enabled` / `time` / `timeZone` | `true` / `00:30` / system | nightly curation |
| `curator.agentPreset` | default | preset for curator sessions (a cheaper model saves money) |
| `curator.maxCharsPerRun` | `120000` | conversation characters read per night |
| `capture.includeCwd` / `excludeCwd` | all / none | which sessions may be curated |
| `recall.limit` / `snippetChars` | `5` / `400` | recall result size |
| `pools.promoteVotes` / `stagingExpireDays` | `2` / `60` | promotion and expiry |
| `skills.maxSkills` / `linkTargets` | `20` / `~/.agents/skills` | skills produced and where they are linked |

## Limits

- Conversations become memories after the nightly curation (T+1), except what you ask to remember.
- "Check memory before searching the web" is a prompt instruction; a model may occasionally skip it.
- Quality depends on the curator model. The gate guarantees real evidence, no transcription, no resurrection of retired knowledge, and no overwrite of your edits — not that every conclusion is right.

## License

MIT

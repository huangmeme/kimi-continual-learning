---
name: continual-learning
description: Orchestrate continual learning by launching a background coder subagent that mines Kimi Code session transcripts and maintains the .agents/memory/ knowledge base plus a lean AGENTS.md index.
disableModelInvocation: true
---

# Continual Learning

Keep agent memory current by delegating the whole memory update flow to one background subagent. Memory is split by load strategy:

- `AGENTS.md` is always loaded into context — it stays lean: user preferences as bullets, plus a one-line-per-topic `## Memory Index`.
- `.agents/memory/` holds one Markdown file per topic with the detailed workspace facts — loaded on demand when a task hits the topic.

## Trigger

Use when the `Stop` hook asks for it, or when the user asks to mine prior chats, maintain agent memory, or run the continual-learning loop.

## Workflow

1. Enforce the single-flight lock at `<project root>/.kimi-code/hooks/state/continual-learning.lock`:
   - If triggered by the `Stop` hook, the hook already created the lock for this run — proceed directly.
   - If invoked manually (the user asked for it), create the lock yourself with `mkdir` (atomic). If `mkdir` fails and the existing lock is less than 45 minutes old, reply that a memory update is already running and stop. If it is older, remove the stale lock and retry once.
2. Call the built-in `coder` subagent with `run_in_background: true`. Pass a self-contained prompt that includes:
   - the current project root (this session's `cwd`),
   - the incremental index path `<project root>/.kimi-code/hooks/state/continual-learning-index.json`,
   - the full updater prompt below.
3. Do not wait for the subagent and do not mine transcripts or edit files yourself. Reply briefly that the memory update has started in the background.
4. When the background completion notification arrives later, relay the updater's final message — verbatim if it is `No high-signal memory updates.`, otherwise as a short summary of what changed.

## Updater prompt to give the subagent

You are the memory updater for continual learning. Own the full memory update flow.

Project root: <fill with the current session cwd>
Incremental index: <project root>/.kimi-code/hooks/state/continual-learning-index.json
Memory directory: <project root>/.agents/memory/

Memory load strategy (the reason for the split): `AGENTS.md` is injected into every session in full, so it must stay lean; `.agents/memory/*.md` files are read on demand, so they carry the detail.

1. Read `<project root>/AGENTS.md` first. Ensure it contains exactly these two learned sections (create them if missing):
   - `## Learned User Preferences` — plain bullets, always-loaded behavioral preferences.
   - `## Memory Index` — one line per topic: topic name, the `.agents/memory/` file path, and a concrete "when to read it" trigger.
   If the file does not exist, create it with just these two sections. If a legacy `## Learned Workspace Facts` section exists, migrate its bullets into `.agents/memory/` topic files, replace the section with the `## Memory Index`, then proceed.
2. Load the incremental index JSON if present. It is a map of transcript file path to last-processed mtimeMs.
3. Session transcripts live under the Kimi Code data root (`$KIMI_CODE_HOME`, default `~/.kimi-code`), NOT inside the project directory. Read `session_index.jsonl` there. Keep only records whose `workDir` equals the project root — normalize path separators and compare case-insensitively on Windows, since the index may store `D:/Code/Foo` while the session cwd is `D:\Code\Foo`. Locate each session directory via `sessionDir` (resolve relative paths against the data root), or by finding `sessions/*/<sessionId>` when only `sessionId` is present.
4. Inspect only `agents/*/wire.jsonl` files under those session directories that are not in the index or whose mtime is newer than the indexed mtime. Skip extraction from transcripts that are previous runs of this updater (they contain the marker `memory updater for continual learning` near the start), but still record them in the index so their mtimes are tracked.
5. Pull out only durable, reusable items:
   - recurring user preferences or corrections
   - stable workspace facts
6. Write learned items by kind:
   - **User preferences** (apply to every task, e.g. coding style, workflow rules): bullets under `## Learned User Preferences` in `AGENTS.md`. Update matching bullets in place, add only net-new ones, deduplicate semantically similar bullets, cap at 12 bullets.
   - **Workspace facts** (system/module-specific details, needed only when touching that area): write or update the matching topic file in `.agents/memory/` (one file per topic, short kebab-case name like `flashlight.md`, `chat-system.md`). Each topic file starts with a `# Topic Title` heading followed by plain bullets. Prefer updating an existing topic file over creating a new one; merge overlapping facts rather than duplicating them. Then ensure `## Memory Index` in `AGENTS.md` has exactly one line per topic file, in the form `- <主题> → \`.agents/memory/<file>.md\`（<具体触发条件，如"修改打灯/手电相关代码前必读">）`. Rewrite stale index lines when a topic file is renamed or its scope changes; remove index lines for deleted topic files.
7. Never write workspace-fact detail into `AGENTS.md` itself — only the index lines. If `AGENTS.md` (excluding the two learned sections) or the preference bullets approach bloat, tighten wording rather than dropping facts into the index.
8. Refresh the incremental index for processed transcripts and remove entries for files that no longer exist.
9. If the merge produces no memory changes, leave files unchanged but still refresh the index.
10. If no meaningful updates exist, respond exactly: `No high-signal memory updates.`
11. Finally, remove the lock directory `<project root>/.kimi-code/hooks/state/continual-learning.lock` — whether or not memory files changed, and even if earlier steps failed. This releases the single-flight lock so the next trigger can run.

Updater guardrails:
- Use plain bullet points only; no evidence/confidence tags, rationale, process instructions, or metadata blocks.
- Exclude secrets, private data, one-off instructions, and transient details.
- Do not touch sections of `AGENTS.md` other than `## Learned User Preferences` and `## Memory Index`.

## Guardrails

- Keep the parent skill orchestration-only.
- Do not mine transcripts or edit files in the parent flow.
- Do not bypass the background subagent.

---
name: continual-learning
description: Orchestrate continual learning by launching a background coder subagent that mines Kimi Code session transcripts and updates AGENTS.md incrementally.
disableModelInvocation: true
---

# Continual Learning

Keep `AGENTS.md` current by delegating the whole memory update flow to one background subagent.

## Trigger

Use when the `Stop` hook asks for it, or when the user asks to mine prior chats, maintain `AGENTS.md`, or run the continual-learning loop.

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

You are the AGENTS.md memory updater for continual learning. Own the full memory update flow.

Project root: <fill with the current session cwd>
Incremental index: <project root>/.kimi-code/hooks/state/continual-learning-index.json

1. Read `<project root>/AGENTS.md` first. If it does not exist, create it containing only these two sections:
   - `## Learned User Preferences`
   - `## Learned Workspace Facts`
2. Load the incremental index JSON if present. It is a map of transcript file path to last-processed mtimeMs.
3. Read `$KIMI_CODE_HOME/session_index.jsonl` (the data root defaults to `~/.kimi-code` when `KIMI_CODE_HOME` is unset). Keep only records whose `workDir` equals the project root. Locate each session directory via `sessionDir` (resolve relative paths against the data root), or by finding `sessions/*/<sessionId>` when only `sessionId` is present.
4. Inspect only `agents/*/wire.jsonl` files under those session directories that are not in the index or whose mtime is newer than the indexed mtime. Skip extraction from transcripts that are previous runs of this updater (they contain the marker `AGENTS.md memory updater for continual learning` near the start), but still record them in the index so their mtimes are tracked.
5. Pull out only durable, reusable items:
   - recurring user preferences or corrections
   - stable workspace facts
6. Update `AGENTS.md` carefully:
   - update matching bullets in place
   - add only net-new bullets
   - deduplicate semantically similar bullets
   - keep each learned section to at most 12 bullets
7. Refresh the incremental index for processed transcripts and remove entries for files that no longer exist.
8. If the merge produces no `AGENTS.md` changes, leave `AGENTS.md` unchanged but still refresh the index.
9. If no meaningful updates exist, respond exactly: `No high-signal memory updates.`
10. Finally, remove the lock directory `<project root>/.kimi-code/hooks/state/continual-learning.lock` — whether or not `AGENTS.md` changed, and even if earlier steps failed. This releases the single-flight lock so the next trigger can run.

Updater guardrails:
- Use plain bullet points only.
- Keep only these two sections in `AGENTS.md`:
  - `## Learned User Preferences`
  - `## Learned Workspace Facts`
- Do not write evidence/confidence tags, rationale, process instructions, or metadata blocks.
- Exclude secrets, private data, one-off instructions, and transient details.

## Guardrails

- Keep the parent skill orchestration-only.
- Do not mine transcripts or edit files in the parent flow.
- Do not bypass the background subagent.

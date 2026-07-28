#!/usr/bin/env node
// Stop hook for the continual-learning plugin.
// Counts completed turns and, when the cadence is met, blocks the Stop event
// with a follow-up message that asks the model to run the continual-learning skill.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const DEFAULT_MIN_TURNS = 10;
const DEFAULT_MIN_MINUTES = 120;
const TRIAL_DEFAULT_MIN_TURNS = 3;
const TRIAL_DEFAULT_MIN_MINUTES = 15;
const TRIAL_DEFAULT_DURATION_MINUTES = 24 * 60;
const DEFAULT_LOCK_STALE_MINUTES = 45;

function parsePositiveInt(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(value) {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readEnvValue(primary, legacy) {
  return process.env[primary] ?? process.env[legacy];
}

function kimiHome() {
  return process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolvePromise(data));
    process.stdin.on("error", reject);
  });
}

function defaultState() {
  return {
    version: 1,
    lastRunAtMs: 0,
    turnsSinceLastRun: 0,
    lastTranscriptMtimeMs: null,
    trialStartedAtMs: null,
  };
}

function loadState(statePath) {
  const fallback = defaultState();
  if (!existsSync(statePath)) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
    if (parsed.version !== 1) {
      return fallback;
    }
    return {
      version: 1,
      lastRunAtMs:
        typeof parsed.lastRunAtMs === "number" && Number.isFinite(parsed.lastRunAtMs)
          ? parsed.lastRunAtMs
          : 0,
      turnsSinceLastRun:
        typeof parsed.turnsSinceLastRun === "number" &&
        Number.isFinite(parsed.turnsSinceLastRun) &&
        parsed.turnsSinceLastRun >= 0
          ? parsed.turnsSinceLastRun
          : 0,
      lastTranscriptMtimeMs:
        typeof parsed.lastTranscriptMtimeMs === "number" && Number.isFinite(parsed.lastTranscriptMtimeMs)
          ? parsed.lastTranscriptMtimeMs
          : null,
      trialStartedAtMs:
        typeof parsed.trialStartedAtMs === "number" && Number.isFinite(parsed.trialStartedAtMs)
          ? parsed.trialStartedAtMs
          : null,
    };
  } catch {
    return fallback;
  }
}

function saveState(statePath, state) {
  const directory = dirname(statePath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function findSessionDirById(sessionId) {
  const sessionsRoot = join(kimiHome(), "sessions");
  if (!existsSync(sessionsRoot)) {
    return null;
  }
  for (const bucket of readdirSync(sessionsRoot)) {
    const candidate = join(sessionsRoot, bucket, sessionId);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Windows path separators and drive-letter casing differ between sources:
// session_index.jsonl stores forward slashes ("D:/Code/Foo") while
// resolve(input.cwd) yields backslashes ("D:\Code\Foo"). Normalize both sides
// before comparing.
function normalizeWorkDir(workDir) {
  const normalized = resolve(workDir).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sessionDirsForWorkDir(workDir) {
  const indexPath = join(kimiHome(), "session_index.jsonl");
  if (!existsSync(indexPath)) {
    return [];
  }
  const targetWorkDir = normalizeWorkDir(workDir);
  const dirs = new Set();
  for (const line of readFileSync(indexPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const record = JSON.parse(trimmed);
      if (typeof record.workDir !== "string" || normalizeWorkDir(record.workDir) !== targetWorkDir) {
        continue;
      }
      if (typeof record.sessionDir === "string" && record.sessionDir) {
        const sessionDir = isAbsolute(record.sessionDir)
          ? record.sessionDir
          : join(kimiHome(), record.sessionDir);
        if (existsSync(sessionDir)) {
          dirs.add(sessionDir);
          continue;
        }
      }
      if (typeof record.sessionId === "string" && record.sessionId) {
        const sessionDir = findSessionDirById(record.sessionId);
        if (sessionDir) {
          dirs.add(sessionDir);
        }
      }
    } catch {
      // Ignore malformed index lines.
    }
  }
  return [...dirs];
}

function latestTranscriptMtimeMs(workDir) {
  let latest = null;
  for (const sessionDir of sessionDirsForWorkDir(workDir)) {
    const agentsDir = join(sessionDir, "agents");
    if (!existsSync(agentsDir)) {
      continue;
    }
    for (const agentDir of readdirSync(agentsDir)) {
      const wirePath = join(agentsDir, agentDir, "wire.jsonl");
      try {
        const mtimeMs = statSync(wirePath).mtimeMs;
        if (latest === null || mtimeMs > latest) {
          latest = mtimeMs;
        }
      } catch {
        // Ignore missing/unreadable wire files.
      }
    }
  }
  return latest;
}

// Single-flight lock: a directory whose creation is atomic. Returns true when
// the lock was acquired, false when another updater still holds it. A lock
// older than staleMinutes is treated as abandoned (updater crashed) and reclaimed.
function acquireLock(lockPath, staleMinutes) {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    mkdirSync(lockPath);
    return true;
  } catch {
    // Lock already exists; check whether it is stale.
  }
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs < staleMinutes * 60_000) {
      return false;
    }
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  try {
    const rawInput = await readStdin();
    const input = rawInput.trim() ? JSON.parse(rawInput) : {};
    const projectRoot =
      typeof input.cwd === "string" && input.cwd ? resolve(input.cwd) : process.cwd();

    const stateDir = join(projectRoot, ".kimi-code", "hooks", "state");
    const statePath = join(stateDir, "continual-learning.json");
    const indexPath = join(stateDir, "continual-learning-index.json");
    const lockPath = join(stateDir, "continual-learning.lock");
    const state = loadState(statePath);
    const now = Date.now();

    const trialEnabled = parseBoolean(
      readEnvValue("CONTINUAL_LEARNING_TRIAL_MODE", "CONTINUOUS_LEARNING_TRIAL_MODE")
    );
    if (trialEnabled && state.trialStartedAtMs === null) {
      state.trialStartedAtMs = now;
    }

    const trialDurationMinutes = parsePositiveInt(
      readEnvValue(
        "CONTINUAL_LEARNING_TRIAL_DURATION_MINUTES",
        "CONTINUOUS_LEARNING_TRIAL_DURATION_MINUTES"
      ),
      TRIAL_DEFAULT_DURATION_MINUTES
    );
    const trialMinTurns = parsePositiveInt(
      readEnvValue("CONTINUAL_LEARNING_TRIAL_MIN_TURNS", "CONTINUOUS_LEARNING_TRIAL_MIN_TURNS"),
      TRIAL_DEFAULT_MIN_TURNS
    );
    const trialMinMinutes = parsePositiveInt(
      readEnvValue("CONTINUAL_LEARNING_TRIAL_MIN_MINUTES", "CONTINUOUS_LEARNING_TRIAL_MIN_MINUTES"),
      TRIAL_DEFAULT_MIN_MINUTES
    );
    const inTrialWindow =
      trialEnabled &&
      state.trialStartedAtMs !== null &&
      now - state.trialStartedAtMs < trialDurationMinutes * 60_000;

    const minTurns = parsePositiveInt(
      readEnvValue("CONTINUAL_LEARNING_MIN_TURNS", "CONTINUOUS_LEARNING_MIN_TURNS"),
      DEFAULT_MIN_TURNS
    );
    const minMinutes = parsePositiveInt(
      readEnvValue("CONTINUAL_LEARNING_MIN_MINUTES", "CONTINUOUS_LEARNING_MIN_MINUTES"),
      DEFAULT_MIN_MINUTES
    );

    const effectiveMinTurns = inTrialWindow ? trialMinTurns : minTurns;
    const effectiveMinMinutes = inTrialWindow ? trialMinMinutes : minMinutes;
    const turnsSinceLastRun = state.turnsSinceLastRun + 1;
    const minutesSinceLastRun =
      state.lastRunAtMs > 0
        ? Math.floor((now - state.lastRunAtMs) / 60_000)
        : Number.POSITIVE_INFINITY;
    const transcriptMtimeMs = latestTranscriptMtimeMs(projectRoot);
    const hasTranscriptAdvanced =
      transcriptMtimeMs !== null &&
      (state.lastTranscriptMtimeMs === null || transcriptMtimeMs > state.lastTranscriptMtimeMs);

    const shouldTrigger =
      turnsSinceLastRun >= effectiveMinTurns &&
      minutesSinceLastRun >= effectiveMinMinutes &&
      hasTranscriptAdvanced;

    if (shouldTrigger) {
      const lockStaleMinutes = parsePositiveInt(
        readEnvValue(
          "CONTINUAL_LEARNING_LOCK_STALE_MINUTES",
          "CONTINUOUS_LEARNING_LOCK_STALE_MINUTES"
        ),
        DEFAULT_LOCK_STALE_MINUTES
      );
      if (!acquireLock(lockPath, lockStaleMinutes)) {
        // Another updater is still running. Keep the cadence counters untouched
        // so a later Stop event re-evaluates and triggers once the lock is free.
        state.turnsSinceLastRun = turnsSinceLastRun;
        saveState(statePath, state);
        process.exitCode = 0;
        return;
      }

      state.lastRunAtMs = now;
      state.turnsSinceLastRun = 0;
      state.lastTranscriptMtimeMs = transcriptMtimeMs;
      saveState(statePath, state);

      // NOTE: the skill has disableModelInvocation: true, so the model cannot
      // invoke it via the Skill tool — this message must stay self-contained.
      // Keep it consistent with skills/continual-learning/SKILL.md.
      console.error(
        `Run the continual-learning memory update now. Launch the built-in \`coder\` subagent in the background (run_in_background: true) for the full memory update flow. Use incremental transcript processing with index file \`${indexPath}\`: only consider session wire.jsonl files not in the index or whose mtime is newer than the indexed mtime. Have the subagent refresh index mtimes, remove entries for deleted transcripts, and update \`AGENTS.md\` only for high-signal recurring user corrections and durable workspace facts. Exclude one-off/transient details and secrets. The lock directory \`${lockPath}\` was created for this run; the subagent must remove it when it finishes (success or failure) so later runs are not skipped. Do not wait for the background subagent; when its completion notification arrives, relay its final message. If no meaningful updates exist, the subagent should respond exactly: No high-signal memory updates.`
      );
      process.exitCode = 2;
      return;
    }

    state.turnsSinceLastRun = turnsSinceLastRun;
    saveState(statePath, state);
    process.exitCode = 0;
  } catch {
    // Fail-open: a hook error must never block the user's turn.
    process.exitCode = 0;
  }
}

await main();

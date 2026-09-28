#!/usr/bin/env node
// Stop hook for the continual-learning plugin.
// Counts completed turns and, when the cadence is met, blocks the Stop event
// with a follow-up message that asks the model to run the continual-learning skill.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
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
const STATE_LOCK_RETRIES = 5;
const STATE_LOCK_RETRY_MS = 25;
const STATE_LOCK_STALE_MS = 60_000;
const LOCK_ACQUIRE_RETRIES = 4;

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

// Settings can also come from <projectRoot>/.kimi-code/hooks/state/
// continual-learning.config.json because persistent env vars are awkward to
// manage on Windows; env vars still win when both are present.
function loadConfigFile(projectRoot) {
  const configPath = join(
    projectRoot,
    ".kimi-code",
    "hooks",
    "state",
    "continual-learning.config.json"
  );
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function setting({ envNames, configKey, config, parse, fallback }) {
  let fromEnv;
  for (const envName of envNames) {
    fromEnv = fromEnv ?? process.env[envName];
  }
  if (fromEnv) {
    return parse(fromEnv, fallback);
  }
  const fromConfig = config[configKey];
  if (fromConfig !== undefined && fromConfig !== null && fromConfig !== "") {
    return parse(String(fromConfig), fallback);
  }
  return fallback;
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

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function defaultState() {
  return {
    version: 1,
    lastRunAtMs: 0,
    turnsSinceLastRun: 0,
    transcriptWatermarkMs: null,
    trialStartedAtMs: null,
    pendingRun: null,
  };
}

// pendingRun records an automatic trigger awaiting confirmation:
// { atMs, previous: { lastRunAtMs, turnsSinceLastRun, transcriptWatermarkMs } }.
// The updater's cleanup step resolves it; if it dies first, the hook rolls the
// cadence back once the updater lock is gone. A malformed entry is dropped
// because there is no trustworthy snapshot to roll back to.
function validatePendingRun(value) {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const atMs = finiteOrNull(value.atMs);
  const previous =
    typeof value.previous === "object" && value.previous !== null ? value.previous : null;
  if (atMs === null || !previous) {
    return null;
  }
  const lastRunAtMs = finiteOrNull(previous.lastRunAtMs);
  const turnsSinceLastRun = finiteOrNull(previous.turnsSinceLastRun);
  const rawWatermark = previous.transcriptWatermarkMs;
  const transcriptWatermarkMs =
    rawWatermark === null || rawWatermark === undefined ? null : finiteOrNull(rawWatermark);
  if (lastRunAtMs === null || turnsSinceLastRun === null) {
    return null;
  }
  if (rawWatermark !== null && rawWatermark !== undefined && transcriptWatermarkMs === null) {
    return null;
  }
  return { atMs, previous: { lastRunAtMs, turnsSinceLastRun, transcriptWatermarkMs } };
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
    // `lastTranscriptMtimeMs` is the pre-watermark field name; migrate on read.
    const transcriptWatermarkMs =
      finiteOrNull(parsed.transcriptWatermarkMs) ?? finiteOrNull(parsed.lastTranscriptMtimeMs);
    return {
      version: 1,
      lastRunAtMs: finiteOrNull(parsed.lastRunAtMs) ?? 0,
      turnsSinceLastRun:
        finiteOrNull(parsed.turnsSinceLastRun) !== null && parsed.turnsSinceLastRun >= 0
          ? parsed.turnsSinceLastRun
          : 0,
      transcriptWatermarkMs,
      trialStartedAtMs: finiteOrNull(parsed.trialStartedAtMs),
      pendingRun: validatePendingRun(parsed.pendingRun),
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

// True when any wire.jsonl transcript for this workDir exists (sinceMs null)
// or is newer than sinceMs. Early-exits on the first match; precise per-file
// accounting lives in the skill's own incremental index.
function hasTranscriptSince(workDir, sinceMs) {
  for (const sessionDir of sessionDirsForWorkDir(workDir)) {
    const agentsDir = join(sessionDir, "agents");
    if (!existsSync(agentsDir)) {
      continue;
    }
    for (const agentDir of readdirSync(agentsDir)) {
      try {
        const mtimeMs = statSync(join(agentsDir, agentDir, "wire.jsonl")).mtimeMs;
        if (sinceMs === null || mtimeMs > sinceMs) {
          return true;
        }
      } catch {
        // Ignore missing/unreadable wire files.
      }
    }
  }
  return false;
}

function lockAgeMs(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function randomId() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readLockToken(lockPath) {
  try {
    return readFileSync(join(lockPath, "token"), "utf-8").trim();
  } catch {
    return null;
  }
}

// Single-flight lock: a directory whose creation is atomic. Returns the owner
// token on success, null when another updater still holds the lock. A lock
// older than staleMinutes is treated as abandoned (updater crashed) and
// reclaimed by renaming it aside first — rename is atomic, so exactly one
// concurrent reclaimer wins and a freshly created lock is never deleted.
function acquireLock(lockPath, staleMinutes) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const id = randomId();
  for (let attempt = 0; attempt < LOCK_ACQUIRE_RETRIES; attempt += 1) {
    try {
      mkdirSync(lockPath);
    } catch {
      // Held; reclaim only when stale.
      const ageMs = lockAgeMs(lockPath);
      if (ageMs !== null && ageMs < staleMinutes * 60_000) {
        return null;
      }
      try {
        renameSync(lockPath, `${lockPath}.stale.${id}`);
      } catch {
        // Vanished or another reclaimer won; the next attempt re-evaluates.
        continue;
      }
      rmSync(`${lockPath}.stale.${id}`, { recursive: true, force: true });
      continue;
    }
    try {
      writeFileSync(join(lockPath, "token"), id, "utf-8");
    } catch {
      // Ownership stamp failed; release will not match, so the lock is left
      // for the mtime-based stale reclaim instead of being deleted blind.
    }
    return id;
  }
  return null;
}

// Short-lived mutex around the state read-modify-write so concurrent Stop
// hooks (two sessions, same project) cannot lose increments. Same ownership
// rules as the updater lock: reclaim by rename, release only with a matching
// token. Losing it only skips bookkeeping, never blocks the user's turn.
async function acquireStateLock(stateLockPath) {
  mkdirSync(dirname(stateLockPath), { recursive: true });
  const id = randomId();
  for (let attempt = 0; attempt < STATE_LOCK_RETRIES; attempt += 1) {
    try {
      mkdirSync(stateLockPath);
    } catch {
      const ageMs = lockAgeMs(stateLockPath);
      if (ageMs !== null && ageMs <= STATE_LOCK_STALE_MS) {
        await sleep(STATE_LOCK_RETRY_MS);
        continue;
      }
      try {
        renameSync(stateLockPath, `${stateLockPath}.stale.${id}`);
      } catch {
        // Vanished or another reclaimer won; back off and re-evaluate.
        await sleep(STATE_LOCK_RETRY_MS);
        continue;
      }
      rmSync(`${stateLockPath}.stale.${id}`, { recursive: true, force: true });
      continue;
    }
    try {
      writeFileSync(join(stateLockPath, "token"), id, "utf-8");
    } catch {
      // Release will not match without the token; the stale-reclaim path
      // recovers via mtime. Proceed — the directory exists and is ours.
    }
    return id;
  }
  return null;
}

// Release only a lock we still own (matching token): a replaced or reclaimed
// lock belongs to another holder and must never be deleted.
function releaseStateLock(stateLockPath, id) {
  if (!id || readLockToken(stateLockPath) !== id) {
    return;
  }
  try {
    rmSync(stateLockPath, { recursive: true, force: true });
  } catch {
    // A lost state lock only costs an increment or a delayed trigger.
  }
}

function triggerMessage(projectRoot, lockPath, statePath, pendingAtMs) {
  return [
    "Automatic Stop-hook invocation: run the continual-learning skill now without a startup announcement. Read its complete instructions and launch one built-in coder subagent in the background (run_in_background: true); do not wait for completion.",
    `Project root: ${JSON.stringify(projectRoot)}. Kimi Code data root: ${JSON.stringify(kimiHome())}.`,
    `This invocation already acquired the lock at ${JSON.stringify(lockPath)} and recorded a pendingRun entry with atMs ${pendingAtMs} in ${JSON.stringify(statePath)}; follow the skill's failure and cleanup rules: take the state lock, resolve that entry only while its atMs still matches, then release the lock.`,
    "Preserve the existing AGENTS.md structure, merge into matching rules, and put topic details in .agents/memory/. Do not recreate a separate preferences section or duplicate existing guidance.",
    "Use the full updater instructions in the skill as the single source of truth. Report actual memory changes or errors only. Suppress the successful internal result No high-signal memory updates. without sending an acknowledgement; manual invocations still receive a result.",
  ].join(" ");
}

async function main() {
  try {
    const rawInput = await readStdin();
    const input = rawInput.trim() ? JSON.parse(rawInput) : {};
    const projectRoot =
      typeof input.cwd === "string" && input.cwd ? resolve(input.cwd) : process.cwd();

    const stateDir = join(projectRoot, ".kimi-code", "hooks", "state");
    const statePath = join(stateDir, "continual-learning.json");
    const lockPath = join(stateDir, "continual-learning.lock");
    const stateLockPath = join(stateDir, "continual-learning.state.lock");
    const config = loadConfigFile(projectRoot);

    // Losing the state mutex only skips bookkeeping, never blocks the turn.
    const stateLockToken = await acquireStateLock(stateLockPath);
    if (!stateLockToken) {
      process.exitCode = 0;
      return;
    }
    try {
      const state = loadState(statePath);
      const now = Date.now();

      const trialEnabled = setting({
        envNames: ["CONTINUAL_LEARNING_TRIAL_MODE", "CONTINUOUS_LEARNING_TRIAL_MODE"],
        configKey: "trialMode",
        config,
        parse: parseBoolean,
        fallback: false,
      });
      if (trialEnabled && state.trialStartedAtMs === null) {
        state.trialStartedAtMs = now;
      }

      const trialDurationMinutes = setting({
        envNames: [
          "CONTINUAL_LEARNING_TRIAL_DURATION_MINUTES",
          "CONTINUOUS_LEARNING_TRIAL_DURATION_MINUTES",
        ],
        configKey: "trialDurationMinutes",
        config,
        parse: parsePositiveInt,
        fallback: TRIAL_DEFAULT_DURATION_MINUTES,
      });
      const trialMinTurns = setting({
        envNames: ["CONTINUAL_LEARNING_TRIAL_MIN_TURNS", "CONTINUOUS_LEARNING_TRIAL_MIN_TURNS"],
        configKey: "trialMinTurns",
        config,
        parse: parsePositiveInt,
        fallback: TRIAL_DEFAULT_MIN_TURNS,
      });
      const trialMinMinutes = setting({
        envNames: ["CONTINUAL_LEARNING_TRIAL_MIN_MINUTES", "CONTINUOUS_LEARNING_TRIAL_MIN_MINUTES"],
        configKey: "trialMinMinutes",
        config,
        parse: parsePositiveInt,
        fallback: TRIAL_DEFAULT_MIN_MINUTES,
      });
      const inTrialWindow =
        trialEnabled &&
        state.trialStartedAtMs !== null &&
        now - state.trialStartedAtMs < trialDurationMinutes * 60_000;

      const minTurns = setting({
        envNames: ["CONTINUAL_LEARNING_MIN_TURNS", "CONTINUOUS_LEARNING_MIN_TURNS"],
        configKey: "minTurns",
        config,
        parse: parsePositiveInt,
        fallback: DEFAULT_MIN_TURNS,
      });
      const minMinutes = setting({
        envNames: ["CONTINUAL_LEARNING_MIN_MINUTES", "CONTINUOUS_LEARNING_MIN_MINUTES"],
        configKey: "minMinutes",
        config,
        parse: parsePositiveInt,
        fallback: DEFAULT_MIN_MINUTES,
      });
      const lockStaleMinutes = setting({
        envNames: [
          "CONTINUAL_LEARNING_LOCK_STALE_MINUTES",
          "CONTINUOUS_LEARNING_LOCK_STALE_MINUTES",
        ],
        configKey: "lockStaleMinutes",
        config,
        parse: parsePositiveInt,
        fallback: DEFAULT_LOCK_STALE_MINUTES,
      });

      // A pending entry means the previous automatic trigger never resolved:
      // its updater died without cleanup. Once the updater lock is gone or
      // stale, roll the cadence back so the next evaluation re-triggers.
      if (state.pendingRun) {
        const updaterLockAgeMs = lockAgeMs(lockPath);
        const updaterLockHeld =
          updaterLockAgeMs !== null && updaterLockAgeMs < lockStaleMinutes * 60_000;
        if (!updaterLockHeld) {
          state.lastRunAtMs = state.pendingRun.previous.lastRunAtMs;
          state.turnsSinceLastRun = state.pendingRun.previous.turnsSinceLastRun;
          state.transcriptWatermarkMs = state.pendingRun.previous.transcriptWatermarkMs;
          state.pendingRun = null;
        }
      }

      const effectiveMinTurns = inTrialWindow ? trialMinTurns : minTurns;
      const effectiveMinMinutes = inTrialWindow ? trialMinMinutes : minMinutes;
      const turnsSinceLastRun = state.turnsSinceLastRun + 1;
      const minutesSinceLastRun =
        state.lastRunAtMs > 0
          ? Math.floor((now - state.lastRunAtMs) / 60_000)
          : Number.POSITIVE_INFINITY;

      // Cadence gates the transcript scan, so ordinary Stops pay no
      // filesystem cost beyond the session index read.
      const shouldTrigger =
        turnsSinceLastRun >= effectiveMinTurns &&
        minutesSinceLastRun >= effectiveMinMinutes &&
        hasTranscriptSince(projectRoot, state.transcriptWatermarkMs);

      if (shouldTrigger) {
        if (!acquireLock(lockPath, lockStaleMinutes)) {
          // Another updater is still running. Keep the cadence counters untouched
          // so a later Stop event re-evaluates and triggers once the lock is free.
          state.turnsSinceLastRun = turnsSinceLastRun;
          saveState(statePath, state);
          process.exitCode = 0;
          return;
        }

        // The updater resolves this entry in its cleanup step; if it dies
        // first, the pending rollback above restores the cadence instead of
        // burning a full trigger window.
        state.pendingRun = {
          atMs: now,
          previous: {
            lastRunAtMs: state.lastRunAtMs,
            turnsSinceLastRun,
            transcriptWatermarkMs: state.transcriptWatermarkMs,
          },
        };
        state.lastRunAtMs = now;
        state.turnsSinceLastRun = 0;
        // Watermark = trigger moment; anything appended later stays eligible
        // through the skill's own file-level index.
        state.transcriptWatermarkMs = now;
        saveState(statePath, state);

        // SKILL.md is the single source of truth for the update flow; the skill
        // is model-invocable, so this message only needs to point at it.
        console.error(triggerMessage(projectRoot, lockPath, statePath, state.pendingRun.atMs));
        process.exitCode = 2;
        return;
      }

      state.turnsSinceLastRun = turnsSinceLastRun;
      saveState(statePath, state);
      process.exitCode = 0;
    } finally {
      releaseStateLock(stateLockPath, stateLockToken);
    }
  } catch {
    // Fail-open: a hook error must never block the user's turn.
    process.exitCode = 0;
  }
}

await main();

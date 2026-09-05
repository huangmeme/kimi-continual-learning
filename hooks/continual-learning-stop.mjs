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

function triggerMessage(projectRoot, lockPath) {
  return [
    "Automatic Stop-hook invocation: run the continual-learning skill now without a startup announcement. Read its complete instructions and launch one built-in coder subagent in the background (run_in_background: true); do not wait for completion.",
    `Project root: ${JSON.stringify(projectRoot)}. Kimi Code data root: ${JSON.stringify(kimiHome())}.`,
    `This invocation already acquired the lock at ${JSON.stringify(lockPath)}; follow the skill's failure and cleanup rules.`,
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
    const config = loadConfigFile(projectRoot);
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

      // SKILL.md is the single source of truth for the update flow; the skill
      // is model-invocable, so this message only needs to point at it.
      console.error(triggerMessage(projectRoot, lockPath));
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

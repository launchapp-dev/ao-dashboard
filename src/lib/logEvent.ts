import type { StreamEvent } from "../types";

const TOOL_PATH_PARAM_KEYS = new Set([
  "file_path",
  "path",
  "paths",
  "output_path",
  "input_path",
  "target_path",
  "source_path",
  "destination_path",
  "from_path",
  "to_path",
  "old_path",
  "new_path",
  "cwd",
  "directory",
  "dir",
]);

const TOOL_PATH_KEY_SUFFIXES = ["_path", "_paths", "_file", "_files", "_directory", "_dir", "_cwd"];
const NON_PATH_PARAM_KEYS = new Set([
  "command",
  "description",
  "content",
  "new_string",
  "old_string",
  "query",
  "pattern",
  "replacement",
  "text",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePathCandidate(value: string) {
  const trimmed = value.trim().replace(/[),.:;]+$/, "");
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes("\n")) {
    return null;
  }

  return trimmed;
}

export function getEventRunId(event: StreamEvent) {
  return typeof event.run_id === "string"
    ? event.run_id
    : typeof event.meta?.run_id === "string"
      ? event.meta.run_id
      : null;
}

export function getToolParams(event: StreamEvent) {
  const params = event.meta && typeof event.meta === "object" ? event.meta.params : null;
  return isRecord(params) ? params : null;
}

export function getPrimaryBody(event: StreamEvent) {
  if (event.error?.trim()) {
    return event.error;
  }

  if (event.content?.trim()) {
    return event.content;
  }

  return event.msg;
}

export function isMarkdownPreferredEvent(event: StreamEvent) {
  return event.cat === "llm.output"
    || event.cat === "llm.thinking"
    || event.cat === "llm.error";
}

export function shouldRenderMarkdownBody(event: StreamEvent, body: string) {
  return Boolean(body.trim()) && (isMarkdownPreferredEvent(event) || body !== event.msg);
}

export function isToolPathParamKey(key: string) {
  if (TOOL_PATH_PARAM_KEYS.has(key)) {
    return true;
  }

  if (TOOL_PATH_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix))) {
    return true;
  }

  return /(^|_)(path|paths|file|files|directory|dir|cwd)($|_)/.test(key);
}

function collectPathValues(value: unknown, matches: Set<string>) {
  if (typeof value === "string") {
    const normalized = normalizePathCandidate(value);
    if (normalized) {
      matches.add(normalized);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathValues(item, matches);
    }
    return;
  }

  if (isRecord(value)) {
    for (const [key, nestedValue] of Object.entries(value)) {
      if (NON_PATH_PARAM_KEYS.has(key)) {
        continue;
      }

      if (isToolPathParamKey(key)) {
        collectPathValues(nestedValue, matches);
      }
    }
  }
}

export function getToolPaths(event: StreamEvent) {
  const params = getToolParams(event);
  if (!params) {
    return [];
  }

  const matches = new Set<string>();
  for (const [key, value] of Object.entries(params)) {
    if (NON_PATH_PARAM_KEYS.has(key)) {
      continue;
    }

    if (isToolPathParamKey(key)) {
      collectPathValues(value, matches);
    }
  }

  return Array.from(matches).slice(0, 12);
}

import { startTransition, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import type {
  AoCommandHelp,
  AoSessionExit,
  AoSessionOutput,
  AoSessionStarted,
  Project,
} from "./types";

const GLOBAL_SCOPE = "__global__";
const MAX_SESSION_LINES = 1000;
const OUTPUT_FLUSH_MS = 75;

interface Props {
  projects: Project[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function parseJsonLine(line: string): JsonValue | null {
  try {
    return JSON.parse(line) as JsonValue;
  } catch {
    return null;
  }
}

function valueSummary(value: JsonValue): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value === null) return "null";
  if (typeof value === "object") return `Object(${Object.keys(value).length})`;
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function JsonLeaf({ value }: { value: JsonValue }) {
  if (value === null) return <span className="text-muted-foreground">null</span>;
  if (typeof value === "string") return <span className="text-chart-1">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="text-primary">{value}</span>;
  if (typeof value === "boolean") return <span className="text-chart-4">{String(value)}</span>;
  return null;
}

function JsonNode({
  label,
  value,
  defaultOpen = false,
}: {
  label?: ReactNode;
  value: JsonValue;
  defaultOpen?: boolean;
}) {
  if (value === null || typeof value !== "object") {
    return (
      <div className="break-words">
        {label ? <span className="mr-2 text-muted-foreground">{label}</span> : null}
        <JsonLeaf value={value} />
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  const bracketOpen = Array.isArray(value) ? "[" : "{";
  const bracketClose = Array.isArray(value) ? "]" : "}";

  return (
    <details open={defaultOpen} className="group">
      <summary className="cursor-pointer list-none select-none text-foreground marker:content-none">
        <span className="mr-2 text-muted-foreground group-open:hidden">▸</span>
        <span className="mr-2 text-muted-foreground hidden group-open:inline">▾</span>
        {label ? <span className="mr-2 text-muted-foreground">{label}</span> : null}
        <span className="text-foreground">{bracketOpen}</span>
        <span className="ml-2 text-[11px] text-muted-foreground">{valueSummary(value)}</span>
      </summary>
      <div className="ml-6 mt-2 space-y-1 border-l border-border/60 pl-3">
        {entries.map(([entryLabel, entryValue]) => (
          <JsonNode
            key={entryLabel}
            label={
              Array.isArray(value)
                ? <span className="text-muted-foreground">{entryLabel}</span>
                : <span className="text-accent">"{entryLabel}"</span>
            }
            value={entryValue}
          />
        ))}
      </div>
      <div className="ml-6 text-foreground">{bracketClose}</div>
    </details>
  );
}

function OutputEntry({ stream, line }: { stream: string; line: string }) {
  const parsed = useMemo(() => parseJsonLine(line), [line]);

  return (
    <div
      className={cn(
        "border-b border-border/40 py-2",
        stream === "stderr" ? "text-chart-4" : "text-foreground"
      )}
    >
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{stream}</div>
      {parsed === null ? (
        <div className="whitespace-pre-wrap break-words">{line}</div>
      ) : (
        <div className="rounded-md border border-border bg-card/40 px-3 py-2">
          <JsonNode value={parsed} defaultOpen />
        </div>
      )}
    </div>
  );
}

export function CommandCenter({ projects }: Props) {
  const [path, setPath] = useState<string[]>([]);
  const [help, setHelp] = useState<AoCommandHelp | null>(null);
  const [loadingHelp, setLoadingHelp] = useState(true);
  const [extraArgs, setExtraArgs] = useState("");
  const [jsonMode, setJsonMode] = useState(true);
  const [selectedProjectRoot, setSelectedProjectRoot] = useState<string>(GLOBAL_SCOPE);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionCommand, setSessionCommand] = useState("");
  const [sessionRunning, setSessionRunning] = useState(false);
  const [sessionSuccess, setSessionSuccess] = useState<boolean | null>(null);
  const [outputLines, setOutputLines] = useState<Array<{ stream: string; line: string }>>([]);
  const [stdinValue, setStdinValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const helpCacheRef = useRef(new Map<string, AoCommandHelp>());
  const pendingOutputRef = useRef<Array<{ stream: string; line: string }>>([]);
  const outputFlushTimerRef = useRef<number | null>(null);

  const flushPendingOutput = useCallback(() => {
    outputFlushTimerRef.current = null;
    if (pendingOutputRef.current.length === 0) return;

    const batch = pendingOutputRef.current.splice(0, pendingOutputRef.current.length);
    startTransition(() => {
      setOutputLines((prev) => {
        const next = prev.concat(batch);
        return next.length > MAX_SESSION_LINES ? next.slice(next.length - MAX_SESSION_LINES) : next;
      });
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const cacheKey = path.join("\u0000");
    const cached = helpCacheRef.current.get(cacheKey);

    setError(null);
    if (cached) {
      setHelp(cached);
      setLoadingHelp(false);
      return () => {
        cancelled = true;
      };
    }

    setLoadingHelp(true);

    invoke<AoCommandHelp>("get_ao_help", { path })
      .then((payload) => {
        if (!cancelled) {
          helpCacheRef.current.set(cacheKey, payload);
          setHelp(payload);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingHelp(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    const outputPromise = listen<AoSessionOutput>("ao-session-output", (event) => {
      if (event.payload.session_id !== sessionId) return;
      pendingOutputRef.current.push({ stream: event.payload.stream, line: event.payload.line });
      if (pendingOutputRef.current.length > MAX_SESSION_LINES * 2) {
        pendingOutputRef.current.splice(0, pendingOutputRef.current.length - MAX_SESSION_LINES);
      }
      if (outputFlushTimerRef.current === null) {
        outputFlushTimerRef.current = window.setTimeout(flushPendingOutput, OUTPUT_FLUSH_MS);
      }
    });

    const exitPromise = listen<AoSessionExit>("ao-session-exit", (event) => {
      if (event.payload.session_id !== sessionId) return;
      flushPendingOutput();
      setSessionRunning(false);
      setSessionSuccess(event.payload.success);
    });

    return () => {
      if (outputFlushTimerRef.current !== null) {
        window.clearTimeout(outputFlushTimerRef.current);
        outputFlushTimerRef.current = null;
      }
      pendingOutputRef.current = [];
      outputPromise.then((unlisten) => unlisten());
      exitPromise.then((unlisten) => unlisten());
    };
  }, [flushPendingOutput, sessionId]);

  const openPath = (nextPath: string[]) => {
    setPath(nextPath);
    setError(null);
  };

  const handleRun = async () => {
    if (path.length === 0) {
      setError("Select an AO command first.");
      return;
    }

    setError(null);
    pendingOutputRef.current = [];
    if (outputFlushTimerRef.current !== null) {
      window.clearTimeout(outputFlushTimerRef.current);
      outputFlushTimerRef.current = null;
    }
    setOutputLines([]);
    setSessionRunning(true);
    setSessionSuccess(null);

    try {
      const started = await invoke<AoSessionStarted>("start_ao_session", {
        path,
        projectRoot: selectedProjectRoot === GLOBAL_SCOPE ? null : selectedProjectRoot,
        extraArgs: extraArgs.trim() ? extraArgs : null,
        json: jsonMode,
      });
      setSessionId(started.session_id);
      setSessionCommand(started.display_command);
    } catch (err) {
      setSessionRunning(false);
      setError(String(err));
    }
  };

  const handleStop = async () => {
    if (!sessionId) return;
    try {
      await invoke("stop_ao_session", { sessionId });
    } catch (err) {
      setError(String(err));
    }
  };

  const handleSendInput = async () => {
    if (!sessionId || !stdinValue) return;
    try {
      await invoke("write_ao_session_stdin", {
        sessionId,
        input: stdinValue.endsWith("\n") ? stdinValue : `${stdinValue}\n`,
      });
      setStdinValue("");
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="grid h-full min-h-0 gap-3 p-3 sm:p-4 xl:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-[24px] border border-border/80 bg-card/40">
        <div className="border-b border-border px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">AO Command Center</div>
          <div className="mt-1 text-sm text-foreground">{help?.about || "Browse the installed AO CLI surface."}</div>
          <div className="mt-2 flex flex-wrap gap-1">
            <button
              className={cn(
                "rounded border px-2 py-1 text-[11px]",
                path.length === 0 ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
              )}
              onClick={() => openPath([])}
            >
              ao
            </button>
            {path.map((segment, index) => (
              <button
                key={`${segment}-${index}`}
                className={cn(
                  "rounded border px-2 py-1 text-[11px]",
                  index === path.length - 1 ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                )}
                onClick={() => openPath(path.slice(0, index + 1))}
              >
                {segment}
              </button>
            ))}
          </div>
          {help?.usage && (
            <div className="mt-3 rounded border border-border bg-background px-2 py-2 font-mono text-[11px] text-muted-foreground">
              {help.usage}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          {loadingHelp ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">Loading commands...</div>
          ) : help?.commands.length ? (
            help.commands.map((command) => (
              <button
                key={command.name}
                className="mb-1 block w-full rounded-lg border border-transparent px-3 py-2 text-left hover:border-primary/30 hover:bg-background"
                onClick={() => openPath([...path, command.name])}
              >
                <div className="text-sm font-medium text-foreground">{command.name}</div>
                <div className="mt-1 text-[11px] leading-4 text-muted-foreground">{command.about}</div>
              </button>
            ))
          ) : (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              No nested subcommands here. Run the current command with the controls on the right.
            </div>
          )}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[24px] border border-border/80 bg-card/35">
        <div className="border-b border-border bg-card/70 px-4 py-3">
          <div className="grid gap-2 2xl:grid-cols-[200px_1fr_auto_auto]">
            <select
              value={selectedProjectRoot}
              onChange={(event) => setSelectedProjectRoot(event.target.value)}
              aria-label="Select AO command scope"
              className="rounded border border-border bg-background px-3 py-2 text-sm outline-none"
            >
              <option value={GLOBAL_SCOPE}>Global scope</option>
              {projects.map((project) => (
                <option key={project.root} value={project.root}>
                  {project.name}
                </option>
              ))}
            </select>
            <input
              value={extraArgs}
              onChange={(event) => setExtraArgs(event.target.value)}
              placeholder='Extra args, for example: list --status ready or get TASK-001'
              aria-label="Extra AO command arguments"
              className="rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <label className="flex items-center gap-2 rounded border border-border px-3 py-2 text-sm text-muted-foreground">
              <input
                checked={jsonMode}
                onChange={(event) => setJsonMode(event.target.checked)}
                type="checkbox"
                aria-label="Run command in JSON mode"
              />
              JSON
            </label>
            <button
              className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              disabled={sessionRunning || path.length === 0}
              onClick={handleRun}
            >
              Run
            </button>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
              {sessionCommand || (path.length ? `ao ${path.join(" ")}` : "Select a command from the left.")}
            </div>
            {sessionId && (
              <div
                className={cn(
                  "rounded px-2 py-1 text-[11px] font-medium",
                  sessionRunning && "bg-chart-1/15 text-chart-1",
                  !sessionRunning && sessionSuccess === true && "bg-primary/15 text-primary",
                  !sessionRunning && sessionSuccess === false && "bg-chart-5/15 text-chart-5"
                )}
              >
                {sessionRunning ? "running" : sessionSuccess === true ? "completed" : sessionSuccess === false ? "failed" : "idle"}
              </div>
            )}
            <button
              className="rounded border border-border px-3 py-1.5 text-xs text-muted-foreground disabled:opacity-50"
              disabled={!sessionRunning}
              onClick={handleStop}
            >
              Stop
            </button>
          </div>

          {error && <div className="mt-2 text-xs text-chart-5">{error}</div>}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-auto bg-background px-4 py-3 font-mono text-[12px] leading-5">
            {outputLines.length === 0 ? (
              <div className="text-muted-foreground">
                Command output will stream here. Long-running AO commands stay attached until you stop them or they exit.
              </div>
            ) : (
              outputLines.map((entry, index) => (
                <OutputEntry
                  key={`${entry.stream}-${index}`}
                  stream={entry.stream}
                  line={entry.line}
                />
              ))
            )}
          </div>

          <div className="border-t border-border bg-card px-4 py-3">
            <div className="flex gap-2">
              <input
                value={stdinValue}
                onChange={(event) => setStdinValue(event.target.value)}
                placeholder="Send stdin to the running command"
                aria-label="Send stdin to the running command"
                className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
              <button
                className="rounded border border-border px-3 py-2 text-sm text-foreground disabled:opacity-50"
                disabled={!sessionRunning || !stdinValue}
                onClick={handleSendInput}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

import { useEffect, useState } from "react";
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

interface Props {
  projects: Project[];
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

  useEffect(() => {
    let cancelled = false;
    setLoadingHelp(true);
    setError(null);

    invoke<AoCommandHelp>("get_ao_help", { path })
      .then((payload) => {
        if (!cancelled) {
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
      setOutputLines((prev) => [...prev.slice(-999), { stream: event.payload.stream, line: event.payload.line }]);
    });

    const exitPromise = listen<AoSessionExit>("ao-session-exit", (event) => {
      if (event.payload.session_id !== sessionId) return;
      setSessionRunning(false);
      setSessionSuccess(event.payload.success);
    });

    return () => {
      outputPromise.then((unlisten) => unlisten());
      exitPromise.then((unlisten) => unlisten());
    };
  }, [sessionId]);

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
    <div className="grid h-full grid-cols-[340px_minmax(0,1fr)] overflow-hidden">
      <aside className="border-r border-border bg-card/40">
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

        <div className="h-[calc(100%-140px)] overflow-auto px-2 py-2">
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

      <section className="flex min-w-0 flex-col overflow-hidden">
        <div className="border-b border-border bg-card px-4 py-3">
          <div className="grid grid-cols-[200px_1fr_auto_auto] gap-2">
            <select
              value={selectedProjectRoot}
              onChange={(event) => setSelectedProjectRoot(event.target.value)}
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
              className="rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <label className="flex items-center gap-2 rounded border border-border px-3 py-2 text-sm text-muted-foreground">
              <input
                checked={jsonMode}
                onChange={(event) => setJsonMode(event.target.checked)}
                type="checkbox"
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
                <div
                  key={`${entry.stream}-${index}`}
                  className={cn(
                    "whitespace-pre-wrap break-words border-b border-border/40 py-1",
                    entry.stream === "stderr" ? "text-chart-4" : "text-foreground"
                  )}
                >
                  <span className="mr-2 text-[10px] uppercase tracking-wide text-muted-foreground">{entry.stream}</span>
                  {entry.line}
                </div>
              ))
            )}
          </div>

          <div className="border-t border-border bg-card px-4 py-3">
            <div className="flex gap-2">
              <input
                value={stdinValue}
                onChange={(event) => setStdinValue(event.target.value)}
                placeholder="Send stdin to the running command"
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

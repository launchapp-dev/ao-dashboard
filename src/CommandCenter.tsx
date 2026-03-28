import { startTransition, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import type {
  DaemonHealth,
  AoCommandHelp,
  AoSessionExit,
  AoSessionOutput,
  AoSessionStarted,
  FleetFounderOverview,
  FleetTeamSnapshot,
  GlobalAoInfo,
  Project,
  StreamEvent,
} from "./types";

const MAX_SESSION_LINES = 1000;
const OUTPUT_FLUSH_MS = 75;

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

function CompactMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "critical";
}) {
  const toneClass = tone === "success"
    ? "text-chart-1"
    : tone === "warning"
      ? "text-chart-4"
      : tone === "critical"
        ? "text-chart-5"
        : "text-foreground";

  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.03] px-4 py-3">
      <div className={cn("text-lg font-bold", toneClass)}>{value}</div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">{label}</div>
    </div>
  );
}

interface Props {
  projects: Project[];
  health: DaemonHealth[];
  events: StreamEvent[];
  globalAoInfo?: GlobalAoInfo | null;
  onOpenOverview: () => void;
}

interface TeamCommandCard {
  teamId: string;
  teamName: string;
  teamSlug: string;
  mission: string;
  projectCount: number;
  enabledCount: number;
  runningCount: number;
  driftCount: number;
  scheduleCount: number;
  hostCount: number;
  knowledgeCount: number;
  latestAudit: string | null;
  latestPolicy: string | null;
  latestReason: string | null;
  previewCount: number;
  hostPreview: string[];
  reconcileDetails: string[];
}

const TEAM_POLICY_PRESETS = [
  { label: "Manual Only", policy: "manual_only" },
  { label: "Always On", policy: "always_on" },
  { label: "Business Hours", policy: "business_hours" },
  { label: "Nightly", policy: "nightly" },
  { label: "Burst On Backlog", policy: "burst_on_backlog" },
] as const;

const TEAM_OVERRIDE_ACTIONS = [
  { label: "Enable", action: "enable" },
  { label: "Disable", action: "disable" },
  { label: "Start", action: "start" },
  { label: "Stop", action: "stop" },
  { label: "Pause", action: "pause" },
  { label: "Resume", action: "resume" },
] as const;

function groupProjectsByTeam(projects: Project[]) {
  const grouped = new Map<string, { teamId: string; teamName: string; teamSlug: string; projects: Project[] }>();

  for (const project of projects) {
    const existing = grouped.get(project.teamId);
    if (existing) {
      existing.projects.push(project);
      continue;
    }

    grouped.set(project.teamId, {
      teamId: project.teamId,
      teamName: project.teamName,
      teamSlug: project.teamSlug,
      projects: [project],
    });
  }

  return [...grouped.values()]
    .map((entry) => ({
      ...entry,
      projects: [...entry.projects].sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.teamName.localeCompare(right.teamName));
}

function formatPolicyName(policyKind: string | null | undefined) {
  if (!policyKind) return "no policy";
  return policyKind.replace(/_/g, " ");
}

function describeReconcileRow(row: FleetTeamSnapshot["reconcilePreview"]["results"][number]) {
  if (!row.action) {
    return "Already aligned with the current policy.";
  }

  const target = row.target as { resolution?: string; transport?: string; host_name?: string; host_slug?: string; host_address?: string; host_id?: string } | null;
  const commandResult = row.commandResult as { message?: string; state?: string } | null;
  const resolution = target?.resolution ? `resolution ${target.resolution}` : null;
  const transport = target?.transport ? `transport ${target.transport}` : null;
  const host = target?.host_name || target?.host_slug || target?.host_id || target?.host_address
    ? `host ${target.host_name ?? target.host_slug ?? target.host_id ?? target.host_address}`
    : null;

  return [
    `Would ${row.action} because desired ${row.desiredState} differs from observed ${row.observedState ?? "unknown"}.`,
    resolution,
    transport,
    host,
    commandResult?.message ?? null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function CommandCenter({
  projects,
  health,
  events,
  globalAoInfo,
  onOpenOverview,
}: Props) {
  const [path, setPath] = useState<string[]>([]);
  const [help, setHelp] = useState<AoCommandHelp | null>(null);
  const [loadingHelp, setLoadingHelp] = useState(true);
  const [extraArgs, setExtraArgs] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionCommand, setSessionCommand] = useState("");
  const [sessionRunning, setSessionRunning] = useState(false);
  const [sessionSuccess, setSessionSuccess] = useState<boolean | null>(null);
  const [outputLines, setOutputLines] = useState<Array<{ stream: string; line: string }>>([]);
  const [stdinValue, setStdinValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [teamSnapshots, setTeamSnapshots] = useState<Record<string, FleetTeamSnapshot>>({});
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [teamAction, setTeamAction] = useState<string | null>(null);
  const helpCacheRef = useRef(new Map<string, AoCommandHelp>());
  const pendingOutputRef = useRef<Array<{ stream: string; line: string }>>([]);
  const outputFlushTimerRef = useRef<number | null>(null);

  const teamBuckets = useMemo(() => groupProjectsByTeam(projects), [projects]);
  const totalAgents = health.reduce((sum, item) => sum + item.active_agents, 0);
  const totalQueue = health.reduce((sum, item) => sum + item.queued_tasks, 0);
  const runningProjects = health.filter((item) => item.status === "running").length;
  const driftProjects = teamBuckets.reduce((sum, team) => {
    return sum + team.projects.filter((project) => {
      const h = health.find((entry) => entry.root === project.root);
      return project.enabled && h?.status !== "running";
    }).length;
  }, 0);
  const configuredProviders = globalAoInfo?.providers.filter((provider) => provider.configured).length ?? 0;

  const refreshTeamSnapshots = useCallback(async () => {
    if (projects.length === 0) {
      setTeamSnapshots({});
      return;
    }

    setTeamLoading(true);
    setTeamError(null);
    try {
      const overview = await invoke<FleetFounderOverview>("get_founder_overview");
      const next: Record<string, FleetTeamSnapshot> = {};
      for (const snapshot of overview.teams) {
        next[snapshot.team.id] = snapshot;
      }
      setTeamSnapshots(next);
      setTeamError(null);
    } catch (error) {
      setTeamError(String(error));
    } finally {
      setTeamLoading(false);
    }
  }, [projects]);

  useEffect(() => {
    void refreshTeamSnapshots();
  }, [refreshTeamSnapshots]);

  const teamCards = useMemo<TeamCommandCard[]>(() => {
    return teamBuckets.map((team) => {
      const snapshot = teamSnapshots[team.teamId];
      const daemonStatuses = snapshot?.daemonStatuses ?? [];
      const scheduleCount = snapshot?.schedules.filter((schedule) => schedule.enabled).length ?? 0;
      const hostCount = new Set(snapshot?.placements.map((placement) => placement.hostId) ?? []).size;
      const knowledgeCount = (snapshot?.knowledgeDocuments.length ?? 0) + (snapshot?.knowledgeFacts.length ?? 0);
      const driftCount = daemonStatuses.filter((status) => status.desiredState !== status.observedState).length;
      const latestAudit = snapshot?.auditEvents[0]?.summary ?? null;
      const latestPolicy = snapshot?.schedules.find((schedule) => schedule.enabled)?.policyKind ?? snapshot?.schedules[0]?.policyKind ?? null;
      const latestReason = snapshot?.reconcilePreview.results[0]
        ? describeReconcileRow(snapshot.reconcilePreview.results[0])
        : null;
      const hostPreview = (snapshot?.hosts ?? []).slice(0, 2).map((host) => host.name);
      const reconcileDetails = (snapshot?.reconcilePreview.results ?? [])
        .filter((row) => row.action)
        .slice(0, 2)
        .map((row) => describeReconcileRow(row));

      return {
        teamId: team.teamId,
        teamName: team.teamName,
        teamSlug: team.teamSlug,
        mission: snapshot?.team.mission ?? "No mission recorded yet.",
        projectCount: team.projects.length,
        enabledCount: team.projects.filter((project) => project.enabled).length,
        runningCount: team.projects.filter((project) => {
          const entry = health.find((item) => item.root === project.root);
          return entry?.status === "running";
        }).length,
        driftCount,
        scheduleCount,
        hostCount,
        knowledgeCount,
        latestAudit,
        latestPolicy,
        latestReason,
        previewCount: snapshot?.reconcilePreview.results.filter((row) => row.action).length ?? 0,
        hostPreview,
        reconcileDetails,
      };
    });
  }, [health, teamBuckets, teamSnapshots]);

  const hostSummary = useMemo(() => {
    const hostMap = new Map<string, { id: string; name: string; address: string; status: string; teamNames: Set<string>; projectCount: number }>();

    for (const snapshot of Object.values(teamSnapshots)) {
      const teamName = snapshot.team.name;
      for (const host of snapshot.hosts) {
        const existing = hostMap.get(host.id);
        if (existing) {
          existing.teamNames.add(teamName);
        } else {
          hostMap.set(host.id, {
            id: host.id,
            name: host.name,
            address: host.address,
            status: host.status,
            teamNames: new Set([teamName]),
            projectCount: 0,
          });
        }
      }

      for (const placement of snapshot.placements) {
        const host = hostMap.get(placement.hostId);
        if (host) {
          host.projectCount += 1;
        }
      }
    }

    return [...hostMap.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [teamSnapshots]);

  const recentAuditEvents = useMemo(() => {
    return Object.values(teamSnapshots)
      .flatMap((snapshot) => snapshot.auditEvents.map((event) => ({
        teamName: snapshot.team.name,
        occurredAt: event.occurredAt,
        summary: event.summary,
        action: event.action,
      })))
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 8);
  }, [teamSnapshots]);

  const runTeamPolicy = async (teamId: string, policyKind: string, enabled: boolean) => {
    setTeamAction(`${teamId}:${policyKind}`);
    setTeamError(null);
    try {
      const snapshot = teamSnapshots[teamId];
      const timezone = snapshot?.schedules[0]?.timezone
        ?? Intl.DateTimeFormat().resolvedOptions().timeZone
        ?? "UTC";
      await invoke("save_team_schedule", {
        teamId,
        policyKind,
        timezone,
        enabled,
      });
      await refreshTeamSnapshots();
    } catch (actionError) {
      setTeamError(String(actionError));
    } finally {
      setTeamAction(null);
    }
  };

  const runTeamReconcile = async (teamId: string, apply: boolean) => {
    setTeamAction(`${teamId}:${apply ? "apply" : "preview"}`);
    setTeamError(null);
    try {
      await invoke("reconcile_team", { teamId, apply });
      await refreshTeamSnapshots();
    } catch (actionError) {
      setTeamError(String(actionError));
    } finally {
      setTeamAction(null);
    }
  };

  const runTeamOverride = async (
    teamId: string,
    action: (typeof TEAM_OVERRIDE_ACTIONS)[number]["action"],
  ) => {
    setTeamAction(`${teamId}:override:${action}`);
    setTeamError(null);
    try {
      if (action === "enable" || action === "disable") {
        await invoke("set_team_enabled", { teamId, enabled: action === "enable" });
      } else {
        await invoke("run_team_daemon_action", { teamId, action });
      }
      await refreshTeamSnapshots();
    } catch (actionError) {
      setTeamError(String(actionError));
    } finally {
      setTeamAction(null);
    }
  };

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
      setError("Select a fleet command first.");
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
        extraArgs: extraArgs.trim() ? extraArgs : null,
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
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4">
      <section className="rounded-[24px] border border-border/80 bg-card/45 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Founder Command Center</div>
            <div className="text-lg font-bold text-foreground">Company board, policy controls, host roster, and the fleet CLI.</div>
            <div className="max-w-3xl text-sm text-muted-foreground">
              Use this tab to inspect the company as a whole, apply temporary team policies, reconcile teams, and keep the CLI explorer as a secondary surface.
            </div>
            <div className="flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              <span className="rounded border border-white/10 bg-white/5 px-2 py-1">
                AO Sync {globalAoInfo?.sync.configured ? "online" : "local"}
              </span>
              <span className="rounded border border-white/10 bg-white/5 px-2 py-1">
                Providers {configuredProviders}/{globalAoInfo?.providers.length ?? 0}
              </span>
              <span className="rounded border border-white/10 bg-white/5 px-2 py-1">
                Live Events {events.length}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onOpenOverview}
              className="rounded-xl border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-bold text-primary transition-colors hover:bg-primary/15"
            >
              Open Company Overview
            </button>
            <button
              onClick={() => void refreshTeamSnapshots()}
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-bold text-foreground transition-colors hover:bg-white/10"
            >
              {teamLoading ? "Refreshing…" : "Refresh Company State"}
            </button>
          </div>
        </div>

        {teamError && (
          <div className="mt-4 rounded-xl border border-chart-5/30 bg-chart-5/10 px-4 py-3 text-sm text-chart-5">
            {teamError}
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
          <CompactMetric label="Teams" value={String(teamBuckets.length)} />
          <CompactMetric label="Projects" value={String(projects.length)} />
          <CompactMetric label="Running" value={`${runningProjects}/${projects.length}`} tone={runningProjects > 0 ? "success" : "warning"} />
          <CompactMetric label="Drift" value={String(driftProjects)} tone={driftProjects > 0 ? "warning" : "default"} />
          <CompactMetric label="Agents" value={String(totalAgents)} />
          <CompactMetric label="Queue" value={String(totalQueue)} tone={totalQueue > 20 ? "warning" : "default"} />
          <CompactMetric label="Events" value={String(events.length)} />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-foreground">Teams Needing Attention</h3>
              <span className="text-xs text-muted-foreground">{teamCards.filter((team) => team.driftCount > 0 || team.previewCount > 0 || team.scheduleCount === 0).length}</span>
            </div>
            <div className="grid gap-3">
              {teamCards
                .filter((team) => team.driftCount > 0 || team.previewCount > 0 || team.scheduleCount === 0)
                .slice(0, 4)
                .map((team) => (
                  <div key={team.teamId} className="rounded-2xl border border-white/5 bg-white/[0.03] p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-foreground">{team.teamName}</div>
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">{team.teamSlug}</div>
                        <div className="mt-2 text-sm text-muted-foreground">{team.mission}</div>
                      </div>
                      <div className="flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-wider">
                        <span className="rounded border border-chart-4/30 bg-chart-4/10 px-2 py-1 text-chart-4">{team.driftCount} drift</span>
                        <span className="rounded border border-white/10 bg-white/5 px-2 py-1 text-muted-foreground">{team.scheduleCount} policy</span>
                        <span className="rounded border border-white/10 bg-white/5 px-2 py-1 text-muted-foreground">{team.hostCount} hosts</span>
                        <span className="rounded border border-white/10 bg-white/5 px-2 py-1 text-muted-foreground">{team.knowledgeCount} notes</span>
                      </div>
                    </div>

	                    <div className="mt-4 flex flex-wrap gap-2">
	                      {TEAM_POLICY_PRESETS.map((preset) => (
	                        <button
                          key={`${team.teamId}:${preset.policy}`}
                          onClick={() => void runTeamPolicy(team.teamId, preset.policy, true)}
                          disabled={teamAction !== null}
                          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-foreground transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
                        >
                          {teamAction === `${team.teamId}:${preset.policy}` ? "Working…" : preset.label}
                        </button>
                      ))}
                      <button
                        onClick={() => void runTeamReconcile(team.teamId, false)}
                        disabled={teamAction !== null}
                        className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-1.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/15 disabled:cursor-wait disabled:opacity-60"
                      >
                        {teamAction === `${team.teamId}:preview` ? "Previewing…" : "Preview Reconcile"}
                      </button>
                      <button
                        onClick={() => void runTeamReconcile(team.teamId, true)}
                        disabled={teamAction !== null}
                        className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-1.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/15 disabled:cursor-wait disabled:opacity-60"
                      >
	                        {teamAction === `${team.teamId}:apply` ? "Reconciling…" : "Reconcile Now"}
	                      </button>
	                    </div>

	                    <div className="mt-3 flex flex-wrap gap-2">
	                      {TEAM_OVERRIDE_ACTIONS.map((override) => (
	                        <button
	                          key={`${team.teamId}:override:${override.action}`}
	                          onClick={() => void runTeamOverride(team.teamId, override.action)}
	                          disabled={teamAction !== null}
	                          className="rounded-lg border border-white/10 bg-black/10 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
	                        >
	                          {teamAction === `${team.teamId}:override:${override.action}` ? "Working…" : override.label}
	                        </button>
	                      ))}
	                    </div>

	                    <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
	                      <div className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Policy</div>
                        <div className="mt-1 font-medium text-foreground">{formatPolicyName(team.latestPolicy)}</div>
                      </div>
                      <div className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Last Change</div>
                        <div className="mt-1 font-medium text-foreground">{team.latestReason ?? "No reconcile action yet"}</div>
                      </div>
                      <div className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Latest Audit</div>
                        <div className="mt-1 font-medium text-foreground">{team.latestAudit ?? "No audit activity yet"}</div>
                      </div>
	                      <div className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
	                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Projects</div>
	                        <div className="mt-1 font-medium text-foreground">{team.enabledCount}/{team.projectCount} enabled</div>
	                      </div>
	                    </div>

	                    <div className="mt-4 grid gap-2 text-xs text-muted-foreground">
	                      <div className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
	                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Hosts</div>
	                        <div className="mt-1 font-medium text-foreground">
	                          {team.hostPreview.length > 0 ? team.hostPreview.join(" · ") : "Local-only routing"}
	                        </div>
	                      </div>
	                      <div className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
	                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Reconcile Detail</div>
	                        <div className="mt-1 space-y-1">
	                          {team.reconcileDetails.length > 0 ? (
	                            team.reconcileDetails.map((detail) => (
	                              <div key={detail} className="text-foreground">
	                                {detail}
	                              </div>
	                            ))
	                          ) : (
	                            <div className="text-foreground">No pending reconcile actions.</div>
	                          )}
	                        </div>
	                      </div>
	                    </div>
	                  </div>
	                ))}
	            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-foreground">Hosts and Audit</h3>
              <span className="text-xs text-muted-foreground">{hostSummary.length} hosts</span>
            </div>

            <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-4">
              <div className="mb-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Hosts</div>
              <div className="space-y-2">
                {hostSummary.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No explicit hosts are registered yet.</div>
                ) : (
                  hostSummary.slice(0, 6).map((host) => (
                    <div key={host.id} className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-bold text-foreground">{host.name}</div>
                          <div className="text-xs text-muted-foreground">{host.address}</div>
                        </div>
                        <span className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                          {host.status}
                        </span>
                      </div>
                      <div className="mt-2 text-[11px] text-muted-foreground">
                        {host.projectCount} project{host.projectCount === 1 ? "" : "s"} · {host.teamNames.size} team{host.teamNames.size === 1 ? "" : "s"}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-4">
              <div className="mb-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Recent Audit</div>
              <div className="space-y-2">
                {recentAuditEvents.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No audit events loaded yet.</div>
                ) : (
                  recentAuditEvents.map((event) => (
                    <div key={`${event.teamName}:${event.occurredAt}:${event.action}`} className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-bold text-foreground">{event.summary}</div>
                        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{event.teamName}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{event.action}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid min-h-0 gap-3 xl:flex-1 xl:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-[24px] border border-border/80 bg-card/40">
        <div className="border-b border-border px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Fleet Command Center</div>
          <div className="mt-1 text-sm text-foreground">{help?.about || "Browse the installed ao-fleet-cli surface."}</div>
          <div className="mt-2 flex flex-wrap gap-1">
            <button
              className={cn(
                "rounded border px-2 py-1 text-[11px]",
                path.length === 0 ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
              )}
              onClick={() => openPath([])}
            >
              ao-fleet-cli
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
          <div className="grid gap-2 2xl:grid-cols-[220px_1fr_auto]">
            <div className="rounded border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
              Fleet-wide scope
            </div>
            <input
              value={extraArgs}
              onChange={(event) => setExtraArgs(event.target.value)}
              placeholder='Extra args, for example: team-list or daemon-status --refresh'
              aria-label="Extra fleet command arguments"
              className="rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
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
              {sessionCommand || (path.length ? `ao-fleet-cli ${path.join(" ")}` : "Select a command from the left.")}
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
                Command output will stream here. Long-running fleet commands stay attached until you stop them or they exit.
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
  </div>
  );
}

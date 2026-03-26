import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";
import type { FleetProject, StreamEvent, ProjectConfig, TaskInfo, CommitInfo, GlobalAoInfo } from "./types";
import { LogEventList, type LogGroupMode } from "./LogEventList";
import { LogFlow } from "./LogFlow";

const STATUS_COLORS: Record<string, string> = {
  running: "#5d9a80",
  stopped: "#5a6474",
  crashed: "#b85c5c",
  offline: "#465063",
};

const TASK_COLORS: Record<string, string> = {
  done: "#9fb0c9",
  ready: "#6d83a6",
  backlog: "#465063",
  blocked: "#c3893d",
  in_progress: "#7f95b4",
  cancelled: "#b85c5c",
  on_hold: "#8c6b3d",
};

interface Props { projects: FleetProject[]; events: StreamEvent[]; globalAoInfo?: GlobalAoInfo | null; }
type StreamFilter =
  | { type: "all" }
  | { type: "active-runs"; workflowIds: string[]; workflowRefs: string[]; taskIds: string[]; label: string }
  | { type: "workflow"; value: string }
  | { type: "run"; workflowId: string; taskId?: string; workflowRef: string; label: string };
type ActiveRunsStreamFilter = Extract<StreamFilter, { type: "active-runs" }>;
const PROJECT_DETAIL_MAX_EVENTS = 4000;

function getEventRunId(event: StreamEvent) {
  return typeof event.run_id === "string"
    ? event.run_id
    : typeof event.meta?.run_id === "string"
      ? event.meta.run_id
      : null;
}

function getEventKey(event: StreamEvent, index: number) {
  return `${event.project_root ?? event.project}:${event.ts}:${event.cat}:${event.workflow_id ?? ""}:${getEventRunId(event) ?? ""}:${event.task_id ?? ""}:${event.phase_id ?? ""}:${index}`;
}

function getEventIdentity(event: StreamEvent) {
  return `${event.project_root ?? event.project}:${event.ts}:${event.cat}:${event.msg}:${event.workflow_id ?? ""}:${getEventRunId(event) ?? ""}:${event.task_id ?? ""}:${event.phase_id ?? ""}:${event.workflow_ref ?? ""}`;
}

function mergeStreamEvents(existing: StreamEvent[], incoming: StreamEvent[], max: number) {
  const merged = [...existing];
  const seen = new Set(existing.map(getEventIdentity));

  for (const event of incoming) {
    const identity = getEventIdentity(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(event);
  }

  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

function matchesLevelFilter(event: StreamEvent, levelFilter: string) {
  return levelFilter === "all" || event.level === levelFilter;
}

function matchesStreamFilter(event: StreamEvent, streamFilter: StreamFilter) {
  if (streamFilter.type === "all") {
    return true;
  }

  if (streamFilter.type === "active-runs") {
    if (streamFilter.workflowIds.includes(event.workflow_id ?? "")) {
      return true;
    }

    return streamFilter.taskIds.includes(event.task_id ?? "")
      || streamFilter.taskIds.includes(event.subject_id ?? "")
      || streamFilter.workflowRefs.includes(event.workflow_ref ?? "");
  }

  if (streamFilter.type === "workflow") {
    return event.workflow_ref === streamFilter.value;
  }

  if (streamFilter.taskId) {
    if (event.task_id === streamFilter.taskId || event.subject_id === streamFilter.taskId) {
      return true;
    }
  }

  return event.workflow_id === streamFilter.workflowId || event.workflow_ref === streamFilter.workflowRef;
}

function selectProjectStreamEvents(events: StreamEvent[], streamFilter: StreamFilter, levelFilter: string) {
  return events
    .filter((event) => matchesLevelFilter(event, levelFilter) && matchesStreamFilter(event, streamFilter))
    .slice(-PROJECT_DETAIL_MAX_EVENTS);
}

export function FleetOverview({ projects, events, globalAoInfo }: Props) {
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const selected = useMemo(
    () => projects.find((project) => project.root === selectedRoot) ?? null,
    [projects, selectedRoot],
  );
  const eventsByProjectRoot = useMemo(() => {
    const grouped = new Map<string, StreamEvent[]>();
    for (const event of events) {
      const key = event.project_root ?? event.project;
      const existing = grouped.get(key);
      if (existing) {
        existing.push(event);
      } else {
        grouped.set(key, [event]);
      }
    }
    return grouped;
  }, [events]);

  const totalAgents = projects.reduce((s, p) => s + (p.health?.active_agents || 0), 0);
  const totalPool = projects.reduce((s, p) => s + (p.health?.pool_size || 0), 0);
  const totalQueue = projects.reduce((s, p) => s + (p.health?.queued_tasks || 0), 0);
  const totalTasks = projects.reduce((s, p) => s + (p.tasks?.total || 0), 0);
  const totalDone = projects.reduce((s, p) => s + (p.tasks?.done || 0), 0);
  const totalWorkflows = projects.reduce((s, p) => s + p.workflows.length, 0);

  const statusData = Object.entries(
    projects.reduce<Record<string, number>>((acc, p) => {
      const s = p.health?.status || "offline";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {})
  ).map(([name, value]) => ({ name, value }));

  const taskBarData = projects
    .filter((p) => p.tasks && p.tasks.total > 0)
    .map((p) => ({
      name: p.name.replace("launchapp-", "").slice(0, 12),
      done: p.tasks!.done, ready: p.tasks!.ready, backlog: p.tasks!.backlog,
      blocked: p.tasks!.blocked, in_progress: p.tasks!.in_progress,
    }));
  const attentionProjects = useMemo(() => {
    return projects
      .map((project) => ({
        project,
        state: getProjectState(project, eventsByProjectRoot.get(project.root) ?? []),
      }))
      .filter(({ state }) => state.score >= 3)
      .sort((left, right) => right.state.score - left.state.score)
      .slice(0, 4);
  }, [eventsByProjectRoot, projects]);

  return (
    <div className={cn("h-full min-h-0", selected ? "overflow-hidden" : "overflow-auto px-4 pb-4 pt-3 sm:px-5 sm:pb-5")}>
      {!selected ? (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <KPI label="Projects" value={projects.length} />
            <KPI label="Agents" value={`${totalAgents}/${totalPool}`} />
            <KPI label="Workflows" value={totalWorkflows} />
            <KPI label="Queued" value={totalQueue} tone={totalQueue > 20 ? "warning" : "default"} />
            <KPI label="Tasks Done" value={totalDone} />
            <KPI label="Total Tasks" value={totalTasks} />
          </div>

          {attentionProjects.length > 0 && (
            <section className="mb-5 rounded-[20px] border border-white/10 bg-[linear-gradient(135deg,hsla(220,22%,15%,0.96),hsla(220,20%,10%,0.98))] p-4 shadow-[0_20px_44px_rgba(0,0,0,0.18)]">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">Attention lane</div>
                  <div className="mt-1 text-lg font-semibold text-foreground">Start with the projects that need intervention now.</div>
                </div>
                <div className="text-[12px] text-muted-foreground">Prioritized by daemon failure, blocked work, queue pressure, and recent errors.</div>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {attentionProjects.map(({ project, state }) => (
                  <button
                    key={`${project.root}:attention`}
                    type="button"
                    onClick={() => setSelectedRoot(project.root)}
                    className="rounded-[18px] border border-white/10 bg-black/20 px-4 py-3 text-left transition-colors hover:border-primary/30 hover:bg-black/30"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-foreground">{project.name}</div>
                        <div className="mt-1 text-[13px] leading-5 text-muted-foreground">{state.summary}</div>
                      </div>
                      <span className={cn("rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]", stateToneClasses(state.tone))}>
                        {state.label}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                      <span>{project.health?.queued_tasks ?? 0} queued</span>
                      <span>{project.tasks?.blocked ?? 0} blocked</span>
                      <span>{project.workflows.length} active workflows</span>
                    </div>
                    <div className="mt-2 text-[11px] font-medium text-foreground">{state.action}</div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {globalAoInfo && <GlobalAoPanel info={globalAoInfo} />}

          <div className="mb-5 grid gap-5 xl:grid-cols-[240px_minmax(0,1fr)]">
            <div className="bg-card rounded-xl p-4 border border-border">
              <h3 className="text-xs text-muted-foreground mb-2 uppercase tracking-wide font-semibold">Daemon Status</h3>
              <ResponsiveContainer width="100%" height={150}>
                <PieChart>
                  <Pie data={statusData} dataKey="value" cx="50%" cy="50%" innerRadius={30} outerRadius={55}>
                    {statusData.map((d) => (<Cell key={d.name} fill={STATUS_COLORS[d.name] || "#333"} />))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "hsl(220 16% 11%)", border: "1px solid hsl(220 14% 22%)", borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex gap-2 justify-center flex-wrap">
                {statusData.map((d) => (
                  <span key={d.name} className="text-[10px]" style={{ color: STATUS_COLORS[d.name] }}>{d.name}: {d.value}</span>
                ))}
              </div>
            </div>
            <div className="bg-card rounded-xl p-4 border border-border">
              <h3 className="text-xs text-muted-foreground mb-2 uppercase tracking-wide font-semibold">Task Distribution</h3>
              <ResponsiveContainer width="100%" height={170}>
                <BarChart data={taskBarData} barSize={16}>
                  <XAxis dataKey="name" tick={{ fill: "#8b93a3", fontSize: 10 }} />
                  <YAxis tick={{ fill: "#8b93a3", fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: "hsl(220 16% 11%)", border: "1px solid hsl(220 14% 22%)", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="done" stackId="a" fill={TASK_COLORS.done} />
                  <Bar dataKey="ready" stackId="a" fill={TASK_COLORS.ready} />
                  <Bar dataKey="in_progress" stackId="a" fill={TASK_COLORS.in_progress} />
                  <Bar dataKey="backlog" stackId="a" fill={TASK_COLORS.backlog} />
                  <Bar dataKey="blocked" stackId="a" fill={TASK_COLORS.blocked} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="overflow-hidden rounded-[20px] border border-white/10 bg-[linear-gradient(180deg,hsla(219,22%,14%,0.98),hsla(220,22%,10%,0.98))]">
            <div className="hidden grid-cols-[minmax(0,1.4fr)_120px_160px_160px_150px_90px] gap-3 border-b border-white/8 px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground md:grid">
              <div>Project</div>
              <div>State</div>
              <div>Pressure</div>
              <div>Active runs</div>
              <div>Task mix</div>
              <div />
            </div>
            <div className="divide-y divide-white/8">
              {projects.map((p) => (
                <OverviewProjectRow
                  key={p.root}
                  project={p}
                  events={eventsByProjectRoot.get(p.root) ?? []}
                  onClick={() => setSelectedRoot(p.root)}
                />
              ))}
            </div>
          </div>
        </>
      ) : (
        <ProjectDetail
          project={selected}
          events={eventsByProjectRoot.get(selected.root) ?? []}
          onBack={() => setSelectedRoot(null)}
        />
      )}
    </div>
  );
}

function KPI({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "warning" | "critical";
}) {
  const valueClass = tone === "warning" ? "text-chart-4" : tone === "critical" ? "text-chart-5" : "text-foreground";

  return (
    <div className="bg-card rounded-lg border border-border p-3">
      <div className={cn("text-xl font-bold", valueClass)}>{value}</div>
      <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
    </div>
  );
}

function GlobalAoPanel({ info }: { info: GlobalAoInfo }) {
  const configuredProviders = info.providers.filter((provider) => provider.configured);
  const templates = info.workflow_templates.slice(0, 6);

  return (
    <div className="bg-card rounded-xl p-4 border border-border mb-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3 className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">AO Home</h3>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">{info.ao_home}</div>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <MiniStat label="Sync" value={info.sync.configured ? "On" : "Off"} tone={info.sync.configured ? "text-chart-1" : "text-chart-4"} />
          <MiniStat label="Runner Token" value={info.agent_runner_token_configured ? "Set" : "Missing"} tone={info.agent_runner_token_configured ? "text-chart-1" : "text-muted-foreground"} />
          <MiniStat label="Providers" value={`${configuredProviders.length}/${info.providers.length}`} tone="text-foreground" />
          <MiniStat label="Templates" value={info.workflow_templates.length} tone="text-foreground" />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="bg-background rounded-lg border border-border p-3 min-w-0">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Sync</div>
          <div className="text-sm font-semibold text-foreground">{info.sync.server ? shortUrl(info.sync.server) : "Not configured"}</div>
          <div className="text-[11px] text-muted-foreground mt-1">
            {info.sync.project_id ? `Project ${info.sync.project_id}` : "No linked project"}
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground">
            Last sync {info.sync.last_synced_at ? info.sync.last_synced_at : "not recorded"}
          </div>
        </div>

        <div className="bg-background rounded-lg border border-border p-3 min-w-0">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Providers</div>
          <div className="flex flex-col gap-1.5">
            {info.providers.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">No credential providers</div>
            ) : (
              info.providers.slice(0, 6).map((provider) => (
                <div key={provider.name} className="flex items-center gap-2 text-[11px] min-w-0">
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", provider.configured ? "bg-chart-1" : "bg-muted-foreground/30")} />
                  <span className="font-semibold text-foreground shrink-0">{provider.name}</span>
                  <span className="truncate text-muted-foreground">{shortUrl(provider.base_url)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-background rounded-lg border border-border p-3 min-w-0">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Global Workflows</div>
          <div className="flex flex-col gap-2">
            {templates.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">No shared workflow templates</div>
            ) : (
              templates.map((workflow) => (
                <div key={`${workflow.source_file}:${workflow.id}`} className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-foreground truncate">{workflow.id}</span>
                    <span className="shrink-0 text-[9px] text-muted-foreground">{workflow.phase_count} phases</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {workflow.name || workflow.description || workflow.source_file}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-background rounded-lg border border-border p-3 min-w-0">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Top-Level Logs</div>
          <div className="flex flex-col gap-2">
            {info.logs.map((log) => (
              <div key={log.name} className="min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-foreground">{log.name}</span>
                  <span className="shrink-0 text-[9px] text-muted-foreground">
                    {log.exists ? `${formatBytes(log.size_bytes)} · ${formatTimestamp(log.modified_at_ms)}` : "missing"}
                  </span>
                </div>
                {log.recent_lines.length > 0 ? (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {log.recent_lines.map((line, index) => (
                      <div key={`${log.name}:${index}`} className="truncate font-mono text-[10px] text-muted-foreground">
                        {line}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-1 text-[10px] text-muted-foreground">No recent lines</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string | number; tone: string }) {
  return (
    <div className="px-2.5 py-1.5 rounded-md border border-border bg-background text-right">
      <div className={cn("text-sm font-semibold", tone)}>{value}</div>
      <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</div>
    </div>
  );
}

function shortUrl(value?: string) {
  if (!value) return "Unknown";
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(value?: number) {
  if (!value) return "unknown";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type ProjectStateTone = "failed" | "blocked" | "degraded" | "healthy" | "idle";

function getProjectState(project: FleetProject, events: StreamEvent[]) {
  const status = project.health?.status ?? "offline";
  const queueDepth = project.health?.queued_tasks ?? 0;
  const utilization = project.health?.pool_utilization_percent ?? 0;
  const blockedTasks = project.tasks?.blocked ?? 0;
  const errorCount = events.filter((event) => event.level === "error").length;
  const activeRuns = project.workflows.length;

  if (status === "crashed" || status === "offline") {
    return {
      tone: "failed" as const,
      label: status === "crashed" ? "Daemon crashed" : "Offline",
      summary: status === "crashed" ? "The daemon surface is down and needs intervention." : "No daemon surface is available for this project.",
      action: "Inspect recent failures before resuming work.",
      score: 5,
    };
  }

  if (blockedTasks > 0 || queueDepth > 25) {
    return {
      tone: "blocked" as const,
      label: "Needs intervention",
      summary: blockedTasks > 0
        ? `${blockedTasks} blocked task${blockedTasks === 1 ? "" : "s"} are stopping forward progress.`
        : `${queueDepth} queued subjects are building faster than they are being cleared.`,
      action: "Open Task Workbench and unblock or reprioritize work.",
      score: 4,
    };
  }

  if (!project.health?.healthy || errorCount > 0 || utilization > 85) {
    return {
      tone: "degraded" as const,
      label: "Watch closely",
      summary: errorCount > 0
        ? `${errorCount} recent error event${errorCount === 1 ? "" : "s"} need a quick read.`
        : utilization > 85
          ? `Agent capacity is running hot at ${Math.round(utilization)}% utilization.`
          : "The daemon is running but health signals are trending noisy.",
      action: "Use Event Stream to confirm whether this is transient or worsening.",
      score: 3,
    };
  }

  if (activeRuns > 0 || (project.health?.active_agents ?? 0) > 0) {
    return {
      tone: "healthy" as const,
      label: "Operating normally",
      summary: activeRuns > 0
        ? `${activeRuns} active workflow${activeRuns === 1 ? "" : "s"} are progressing without obvious blockers.`
        : "Agents are active and the daemon surface looks healthy.",
      action: "Keep monitoring current runs and queue pressure.",
      score: 2,
    };
  }

  return {
    tone: "idle" as const,
    label: "Ready",
    summary: "No active pressure right now, but the project is available for new work.",
    action: "Use Command Center or Tasks to start the next operation.",
    score: 1,
  };
}

function stateToneClasses(tone: ProjectStateTone) {
  if (tone === "failed") return "border-chart-5/40 bg-chart-5/10 text-chart-5";
  if (tone === "blocked") return "border-chart-4/40 bg-chart-4/10 text-chart-4";
  if (tone === "degraded") return "border-primary/40 bg-primary/10 text-primary";
  if (tone === "healthy") return "border-chart-1/40 bg-chart-1/10 text-chart-1";
  return "border-border bg-background text-muted-foreground";
}

function OverviewProjectRow({ project: p, events, onClick }: { project: FleetProject; events: StreamEvent[]; onClick: () => void }) {
  const status = p.health?.status || "offline";
  const state = getProjectState(p, events);
  const recentEvents = events.slice(-2);
  const queueDepth = p.health?.queued_tasks || 0;
  const utilization = Math.round(p.health?.pool_utilization_percent || 0);
  const blocked = p.tasks?.blocked || 0;
  const inProgress = p.tasks?.in_progress || 0;
  const ready = p.tasks?.ready || 0;
  const backlog = p.tasks?.backlog || 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full px-4 py-4 text-left transition-colors hover:bg-white/[0.035]"
      aria-label={`Open ${p.name} project detail`}
    >
      <div className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_120px_160px_160px_150px_90px] md:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-foreground">{p.name}</span>
            <span className="text-[11px] text-muted-foreground">{status}</span>
          </div>
          <div className="mt-1 text-[13px] leading-5 text-muted-foreground">{state.summary}</div>
          {recentEvents.length > 0 && (
            <div className="mt-2 space-y-1">
              {recentEvents.map((event, index) => (
                <div
                  key={getEventKey(event, index)}
                  className={cn(
                    "overflow-hidden text-ellipsis whitespace-nowrap text-[11px]",
                    event.level === "error" ? "text-chart-5" : event.level === "warn" ? "text-chart-4" : "text-muted-foreground",
                  )}
                >
                  {event.msg.slice(0, 90)}
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]", stateToneClasses(state.tone))}>
            {state.label}
          </span>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Queue</span>
            <span className={cn("font-semibold", queueDepth > 10 ? "text-chart-4" : "text-foreground")}>{queueDepth}</span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Utilization</span>
            <span className="font-semibold text-foreground">{utilization}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full transition-all duration-500"
              style={{
                width: `${p.health?.pool_utilization_percent || 0}%`,
                background: (p.health?.pool_utilization_percent || 0) > 80 ? "#c3893d" : "#6d83a6",
              }}
            />
          </div>
        </div>

        <div className="space-y-1 text-[11px]">
          {p.workflows.slice(0, 2).map((wf, index) => (
            <div key={`${wf.id}:${index}`} className="overflow-hidden text-ellipsis whitespace-nowrap text-foreground">
              {wf.workflow_ref} <span className="text-muted-foreground">→ {wf.current_phase}</span>
            </div>
          ))}
          {p.workflows.length === 0 && <div className="text-muted-foreground">No active workflows</div>}
          {p.workflows.length > 2 && <div className="text-muted-foreground">+{p.workflows.length - 2} more active runs</div>}
        </div>

        <div className="space-y-1 text-[11px] text-muted-foreground">
          <div>Blocked <span className={cn("font-semibold", blocked > 0 ? "text-chart-4" : "text-foreground")}>{blocked}</span></div>
          <div>In progress <span className="font-semibold text-foreground">{inProgress}</span></div>
          <div>Ready <span className="font-semibold text-foreground">{ready}</span></div>
          <div>Backlog <span className="font-semibold text-foreground">{backlog}</span></div>
        </div>

        <div className="flex items-center justify-start md:justify-end">
          <span className="text-[11px] font-medium text-foreground transition-colors group-hover:text-primary">Open →</span>
        </div>
      </div>
    </button>
  );
}

function ProjectDetail({ project: p, events, onBack }: { project: FleetProject; events: StreamEvent[]; onBack: () => void }) {
  const [streamFilter, setStreamFilter] = useState<StreamFilter>({ type: "all" });
  const [levelFilter, setLevelFilter] = useState("all");
  const [textFilter, setTextFilter] = useState("");
  const [groupMode, setGroupMode] = useState<LogGroupMode>("conversation");
  const [streamPresentation, setStreamPresentation] = useState<"list" | "graph">("list");
  const [viewMode, setViewMode] = useState<"stream" | "config" | "tasks" | "commits">("stream");
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [taskList, setTaskList] = useState<TaskInfo[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>(() => events.slice(-PROJECT_DETAIL_MAX_EVENTS));
  const [streamLoading, setStreamLoading] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const projectEvents = useMemo(() => events, [events]);
  const fallbackStreamEvents = useMemo(
    () => selectProjectStreamEvents(projectEvents, streamFilter, levelFilter),
    [levelFilter, projectEvents, streamFilter],
  );
  const activeRunsFilter = useMemo<ActiveRunsStreamFilter | null>(() => {
    if (p.workflows.length === 0) {
      return null;
    }

    return {
      type: "active-runs",
      workflowIds: [...new Set(p.workflows.map((wf) => wf.id).filter(Boolean))],
      workflowRefs: [...new Set(p.workflows.map((wf) => wf.workflow_ref).filter(Boolean))],
      taskIds: [...new Set(p.workflows.map((wf) => wf.task_id).filter((taskId) => taskId && taskId !== "cron"))],
      label: "ACTIVE RUNS",
    };
  }, [p.workflows]);
  const liveStreamParams = useMemo(() => {
    if (streamFilter.type === "active-runs" || streamFilter.type === "run") {
      return {
        workflow: null,
        run: null,
      };
    }

    if (streamFilter.type === "workflow") {
      return {
        workflow: streamFilter.value,
        run: null,
      };
    }

    return {
      workflow: null,
      run: null,
    };
  }, [streamFilter]);

  useEffect(() => {
    invoke<ProjectConfig>("get_project_config", { projectRoot: p.root }).then(setConfig).catch(() => {});
    invoke<TaskInfo[]>("get_task_list", { projectRoot: p.root }).then(setTaskList).catch(() => {});
    invoke<CommitInfo[]>("get_recent_commits", { projectRoot: p.root }).then(setCommits).catch(() => {});
  }, [p.root]);

  useEffect(() => {
    if (viewMode !== "stream") {
      return;
    }

    setStreamEvents((prev) => {
      if (!streamLoading && !streamError && prev.length > 0) {
        return prev;
      }

      return mergeStreamEvents(fallbackStreamEvents, prev, PROJECT_DETAIL_MAX_EVENTS);
    });
  }, [fallbackStreamEvents, streamError, streamLoading, viewMode]);

  useEffect(() => {
    if (viewMode !== "stream") return;

    let disposed = false;
    let activeChannelId: string | null = null;
    let unlisten: (() => void) | null = null;
    const seedEvents = selectProjectStreamEvents(projectEvents, streamFilter, levelFilter);

    setStreamLoading(true);
    setStreamError(null);
    setStreamEvents(seedEvents);

    const streamRequest = {
      projectRoot: p.root,
      workflow: liveStreamParams.workflow,
      run: liveStreamParams.run,
      cat: null,
      level: levelFilter === "all" ? null : levelFilter,
    };

    const connect = async () => {
      let nextError: string | null = null;

      try {
        const recent = await invoke<StreamEvent[]>("get_filtered_events", streamRequest);
        if (!disposed) {
          setStreamEvents(mergeStreamEvents(seedEvents, recent, PROJECT_DETAIL_MAX_EVENTS));
        }
      } catch (error) {
        nextError = `Recent events unavailable: ${String(error)}`;
      }

      try {
        const channelId = await invoke<string>("start_filtered_stream", streamRequest);
        if (disposed) {
          await invoke("stop_filtered_stream", { channelId }).catch(() => {});
          return;
        }

        activeChannelId = channelId;

        unlisten = await listen<StreamEvent>(channelId, (event) => {
          setStreamEvents((prev) => mergeStreamEvents(prev, [event.payload], PROJECT_DETAIL_MAX_EVENTS));
        });
      } catch (error) {
        nextError = nextError ? `${nextError} | Live stream unavailable: ${String(error)}` : `Live stream unavailable: ${String(error)}`;
      } finally {
        if (!disposed) {
          setStreamError(nextError);
          setStreamLoading(false);
        }
      }
    };

    connect();

    return () => {
      disposed = true;
      if (unlisten) unlisten();
      if (activeChannelId) {
        invoke("stop_filtered_stream", { channelId: activeChannelId }).catch(() => {});
      }
    };
  }, [levelFilter, liveStreamParams, p.root, streamFilter, viewMode]);

  const workflowRefs = useMemo(() => {
    const refs = new Map<string, { count: number; active: boolean }>();
    p.workflows.forEach((wf) => refs.set(wf.workflow_ref, { count: 0, active: true }));
    projectEvents.forEach((event) => {
      if (!event.workflow_ref) return;
      const existing = refs.get(event.workflow_ref);
      refs.set(event.workflow_ref, { count: (existing?.count || 0) + 1, active: existing?.active || false });
    });
    return refs;
  }, [p.workflows, projectEvents]);

  const modelNames = useMemo(() => {
    const models = new Map<string, number>();
    projectEvents.forEach((event) => {
      if (event.model) models.set(event.model, (models.get(event.model) || 0) + 1);
    });
    return models;
  }, [projectEvents]);

  const filtered = useMemo(() => {
    const query = textFilter.trim().toLowerCase();
    return streamEvents.filter((event) => {
      if (!matchesLevelFilter(event, levelFilter) || !matchesStreamFilter(event, streamFilter)) {
        return false;
      }

      if (query) {
        const haystack = `${event.msg} ${event.content ?? ""} ${event.error ?? ""} ${event.cat} ${event.tool ?? ""} ${event.workflow_ref ?? ""} ${event.workflow_id ?? ""} ${event.task_id ?? ""} ${getEventRunId(event) ?? ""}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [levelFilter, streamEvents, streamFilter, textFilter]);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [filtered.length, autoScroll]);

  const handleLogScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  const tabBtn = (mode: typeof viewMode, label: string, extra?: string) => (
    <button type="button" onClick={() => setViewMode(mode)} className={cn(
      "px-3 py-1 rounded text-[11px] border transition-colors cursor-pointer",
      viewMode === mode ? "bg-primary/12 border-primary/40 text-foreground" : "bg-transparent border-border text-muted-foreground hover:text-foreground"
    )}>{label}{extra || ""}</button>
  );

  const sidebarItem = (label: string, count: number, active: boolean, onClick: () => void, dot?: string) => (
    <button type="button" onClick={onClick} className={cn(
      "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px]",
      active ? "bg-primary/12 text-foreground" : "text-muted-foreground hover:text-foreground"
    )}>
      {dot && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />}
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
      <span className="text-[9px] text-muted-foreground/50 shrink-0">{count}</span>
    </button>
  );

  return (
    <div className="h-full w-full flex flex-col overflow-hidden">
      <div className="shrink-0 px-5 pt-3">
        <button onClick={onBack} className="mb-3 px-3 py-1.5 rounded border border-border text-muted-foreground text-xs cursor-pointer hover:text-foreground hover:border-primary/30 transition-colors">
          ← Back to Fleet
        </button>

        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-xl font-bold">{p.name}</h2>
          <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded" style={{
            background: `${STATUS_COLORS[p.health?.status || "offline"]}24`,
            color: STATUS_COLORS[p.health?.status || "offline"],
          }}>{p.health?.status || "offline"}</span>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2.5 xl:grid-cols-5">
          <KPI label="Agents" value={`${p.health?.active_agents || 0}/${p.health?.pool_size || 0}`} />
          <KPI label="Queue" value={p.health?.queued_tasks || 0} tone={(p.health?.queued_tasks || 0) > 10 ? "warning" : "default"} />
          <KPI label="Workflows" value={p.workflows.length} />
          <KPI label="Tasks Done" value={p.tasks?.done || 0} />
          <KPI label="Total Tasks" value={p.tasks?.total || 0} />
        </div>

        {p.tasks && (
          <div className="flex gap-3 mb-3 flex-wrap">
            {Object.entries(TASK_COLORS).map(([status, color]) => {
              const count = (p.tasks as unknown as Record<string, number>)?.[status] || 0;
              if (count === 0) return null;
              return (
                <div key={status} className="flex items-center gap-1">
                  <span className="text-sm font-bold" style={{ color }}>{count}</span>
                  <span className="text-[10px] text-muted-foreground">{status}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex gap-1.5 px-5 pb-2 shrink-0">
        {tabBtn("stream", "Stream")}
        {tabBtn("config", "Config")}
        {tabBtn("tasks", "Tasks", taskList.length > 0 ? ` (${taskList.length})` : "")}
        {tabBtn("commits", "Commits")}
      </div>

      {viewMode === "config" && config ? (
        <ConfigView config={config} />
      ) : viewMode === "tasks" ? (
        <TasksView tasks={taskList} />
      ) : viewMode === "commits" ? (
        <CommitsView commits={commits} />
      ) : (
      <div className="flex-1 grid min-h-0 gap-2.5 overflow-hidden px-5 pb-3 xl:grid-cols-[180px_minmax(0,1fr)]">
        <div className="bg-card rounded-lg p-2.5 overflow-auto min-w-0 border border-border">
          {sidebarItem("All Events", projectEvents.length, streamFilter.type === "all", () => setStreamFilter({ type: "all" }), "#6d83a6")}

          {workflowRefs.size > 0 && (
            <>
              <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wide pt-2.5 px-2 pb-1 font-semibold">Workflows</div>
              {[...workflowRefs].map(([ref, { count, active }]) =>
                sidebarItem(ref, count, streamFilter.type === "workflow" && streamFilter.value === ref,
                  () => setStreamFilter({ type: "workflow", value: ref }),
                  active ? "#5d9a80" : "#5a6474")
              )}
            </>
          )}

          {modelNames.size > 0 && (
            <>
              <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wide pt-2.5 px-2 pb-1 font-semibold">Models</div>
              {[...modelNames].map(([name, count]) => (
                <div key={name} className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" />
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{name.replace("kimi-code/", "")}</span>
                  <span className="text-[9px] text-muted-foreground/50">{count}</span>
                </div>
              ))}
            </>
          )}

          {p.workflows.length > 0 && (
            <>
              <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wide pt-2.5 px-2 pb-1 font-semibold">Active Runs</div>
              {activeRunsFilter && sidebarItem(
                activeRunsFilter.label,
                p.workflows.length,
                streamFilter.type === "active-runs",
                () => setStreamFilter(activeRunsFilter),
                "#5d9a80",
              )}
              {p.workflows.map((wf) => (
                <button
                  type="button"
                  key={wf.id}
                  onClick={() => setStreamFilter({
                    type: "run",
                    workflowId: wf.id,
                    taskId: wf.task_id !== "cron" ? wf.task_id : undefined,
                    workflowRef: wf.workflow_ref,
                    label: `${wf.workflow_ref} → ${wf.current_phase}`,
                  })}
                  className={cn(
                    "w-full rounded px-2 py-1 text-left text-[10px]",
                    streamFilter.type === "run" && streamFilter.label === `${wf.workflow_ref} → ${wf.current_phase}` ? "bg-primary/12" : ""
                  )}
                >
                  <div className="flex items-center gap-1">
                    <span className="w-[5px] h-[5px] rounded-full bg-primary animate-pulse" />
                    <span className="font-semibold text-foreground">{wf.workflow_ref}</span>
                  </div>
                  <div className="text-muted-foreground/50 pl-[9px]">
                    {wf.current_phase} ({wf.phase_progress})
                    {wf.task_id !== "cron" && <span className="text-muted-foreground/30"> · {wf.task_id}</span>}
                  </div>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="bg-card rounded-lg flex flex-col min-h-0 min-w-0 overflow-hidden border border-border">
          <div className="flex gap-2 px-3 py-2.5 border-b border-border shrink-0 items-center">
            <span className="text-[11px] text-muted-foreground font-semibold">
              {streamFilter.type === "all"
                ? "ALL"
                : streamFilter.type === "run"
                  ? streamFilter.label
                  : streamFilter.type === "active-runs"
                    ? streamFilter.label
                    : streamFilter.value?.toUpperCase()}
            </span>
            <span className="text-[10px] text-muted-foreground/40">{filtered.length} events</span>
            <span className={cn(
              "rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
              streamLoading ? "bg-primary/12 text-primary" : streamError ? "bg-chart-5/10 text-chart-5" : "bg-chart-1/10 text-chart-1"
            )}>
              {streamLoading ? "syncing" : streamError ? "stream error" : "live"}
            </span>
            <div className="flex-1" />
            <label>
              <span className="sr-only">Filter project events</span>
              <input
                placeholder="Filter..."
                value={textFilter}
                onChange={(e) => setTextFilter(e.target.value)}
                aria-label="Filter project events"
                className="w-40 rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground outline-none focus:border-primary"
              />
            </label>
            <label>
              <span className="sr-only">Filter project events by level</span>
              <select
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
                aria-label="Filter project events by level"
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground outline-none"
              >
                <option value="all">All levels</option>
                <option value="error">Error</option>
                <option value="warn">Warn</option>
                <option value="info">Info</option>
              </select>
            </label>
            <label>
              <span className="sr-only">Group project events by</span>
              <select
                value={groupMode}
                onChange={(e) => setGroupMode(e.target.value as LogGroupMode)}
                aria-label="Group project events by"
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground outline-none"
              >
                <option value="conversation">Conversation</option>
                <option value="workflow">Workflow</option>
                <option value="flat">Flat</option>
              </select>
            </label>
            <label>
              <span className="sr-only">Choose project stream presentation</span>
              <select
                value={streamPresentation}
                onChange={(e) => setStreamPresentation(e.target.value as "list" | "graph")}
                aria-label="Choose project stream presentation"
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground outline-none"
              >
                <option value="list">List</option>
                <option value="graph">Graph</option>
              </select>
            </label>
          </div>

          {streamPresentation === "graph" ? (
            <div className="flex-1 min-h-0 px-3 py-2">
              {streamError && (
                <div className="mb-2 rounded border border-chart-5/30 bg-chart-5/10 px-2 py-1 text-[10px] text-chart-5">
                  {streamError}
                </div>
              )}
              {filtered.length === 0 ? (
                <div className="flex h-full min-h-[620px] items-center justify-center text-center text-muted-foreground/30">
                  {streamLoading ? "Connecting to live stream..." : "No events matching filter"}
                </div>
              ) : (
                <div className="h-[72vh] min-h-[680px]">
                  <LogFlow events={filtered} groupMode={groupMode} />
                </div>
              )}
            </div>
          ) : (
            <div ref={logRef} onScroll={handleLogScroll} className="flex-1 overflow-auto px-3 py-1 font-mono text-[11px] leading-4">
              {streamError && (
                <div className="sticky top-0 z-10 mb-2 rounded border border-chart-5/30 bg-chart-5/10 px-2 py-1 text-[10px] text-chart-5">
                  {streamError}
                </div>
              )}
              {filtered.length === 0 ? (
                <div className="text-muted-foreground/30 p-5 text-center">{streamLoading ? "Connecting to live stream..." : "No events matching filter"}</div>
              ) : (
                <LogEventList
                  events={filtered}
                  groupMode={groupMode}
                  onWorkflowClick={(workflowRef) => setStreamFilter({ type: "workflow", value: workflowRef })}
                />
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

const PRIORITY_COLORS: Record<string, string> = { critical: "#b85c5c", high: "#c3893d", medium: "#8b93a3", low: "#6b7280" };
const TASK_STATUS_COLORS: Record<string, string> = {
  done: "#9fb0c9", ready: "#6d83a6", "in-progress": "#7f95b4", in_progress: "#7f95b4",
  blocked: "#c3893d", backlog: "#5a6474", cancelled: "#b85c5c", "on-hold": "#8c6b3d", on_hold: "#8c6b3d",
};

function TasksView({ tasks }: { tasks: TaskInfo[] }) {
  const [statusFilter, setStatusFilter] = useState("all");
  const statuses = new Map<string, number>();
  tasks.forEach((t) => statuses.set(t.status, (statuses.get(t.status) || 0) + 1));
  const filtered = statusFilter === "all" ? tasks : tasks.filter((t) => t.status === statusFilter);

  return (
    <div className="flex-1 overflow-auto px-5 pb-3">
      <div className="flex gap-2 mb-2.5 flex-wrap items-center">
        <span onClick={() => setStatusFilter("all")}
          className={cn("text-[10px] px-2 py-0.5 rounded cursor-pointer border", statusFilter === "all" ? "bg-primary/12 border-primary/40 text-foreground" : "bg-card border-border text-muted-foreground")}>
          All ({tasks.length})
        </span>
        {[...statuses].sort((a, b) => b[1] - a[1]).map(([status, count]) => (
          <span key={status} onClick={() => setStatusFilter(statusFilter === status ? "all" : status)}
            className={cn("text-[10px] px-2 py-0.5 rounded cursor-pointer border", statusFilter === status ? "bg-primary/12 text-foreground" : "bg-card")}
            style={{ color: status === "blocked" || status === "cancelled" ? TASK_STATUS_COLORS[status] || "#888" : "#cdd5df", borderColor: statusFilter === status ? (TASK_STATUS_COLORS[status] || "#333") : "hsl(220 14% 22%)" }}>
            {status} ({count})
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        {filtered.map((t) => (
          <div key={t.id} className="flex items-center gap-2.5 px-2.5 py-2 bg-card rounded border border-border"
            style={{ borderLeftColor: TASK_STATUS_COLORS[t.status] || "#333", borderLeftWidth: 3 }}>
            <span className="text-[10px] font-bold text-muted-foreground min-w-[65px] font-mono">{t.id}</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold min-w-[60px] text-center"
              style={{ background: `${TASK_STATUS_COLORS[t.status] || "#333"}1a`, color: t.status === "blocked" || t.status === "cancelled" ? TASK_STATUS_COLORS[t.status] || "#888" : "#d8dee7" }}>{t.status}</span>
            <span className="text-[9px] px-1 py-0.5 rounded" style={{ color: PRIORITY_COLORS[t.priority] || "#666" }}>{t.priority}</span>
            <span className="text-[11px] text-foreground flex-1">{t.title}</span>
          </div>
        ))}
        {filtered.length === 0 && <div className="text-muted-foreground text-center p-5 text-xs">No tasks</div>}
      </div>
    </div>
  );
}

function CommitsView({ commits }: { commits: CommitInfo[] }) {
  return (
    <div className="flex-1 overflow-auto px-5 pb-3">
      <div className="bg-card rounded-lg p-3 border border-border">
        {commits.map((c, i) => (
          <div key={i} className="flex gap-2.5 py-1 border-b border-border/50 text-[11px] font-mono">
            <span className="text-primary min-w-[60px] shrink-0">{c.hash}</span>
            <span className="text-muted-foreground min-w-[80px] shrink-0 text-[9px]">{c.date.slice(0, 10)}</span>
            <span className="text-foreground flex-1">{c.message}</span>
          </div>
        ))}
        {commits.length === 0 && <div className="text-muted-foreground text-center p-5 text-xs">No commits</div>}
      </div>
    </div>
  );
}

function cronToHuman(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length < 5) return cron;
  const [min, hour] = parts;
  if (min.startsWith("*/")) return `Every ${min.slice(2)} min`;
  if (min.includes("-") && min.includes("/")) return `Every ${min.split("/")[1]} min`;
  if (hour.startsWith("*/")) return `Every ${hour.slice(2)} hours`;
  if (hour === "*" && min.match(/^\d+$/)) return `Hourly at :${min.padStart(2, "0")}`;
  return cron;
}

function ConfigView({ config }: { config: ProjectConfig }) {
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);

  return (
    <div className="flex-1 overflow-auto px-5 pb-3 grid grid-cols-2 gap-2.5 content-start">
      <div className="flex flex-col gap-2.5">
        <div className="bg-card rounded-lg p-3 border border-border">
          <h3 className="text-[11px] text-muted-foreground/50 uppercase tracking-wide mb-2 font-semibold">Workflows ({config.workflows.length})</h3>
          {config.workflows.map((wf) => (
            <div key={wf.id} className="mb-2.5 p-2 bg-background rounded border border-border">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="font-semibold text-xs text-foreground">{wf.id}</span>
                {wf.name && <span className="text-[10px] text-muted-foreground">- {wf.name}</span>}
              </div>
              {wf.description && <div className="text-[10px] text-muted-foreground/50 mb-1">{wf.description}</div>}
              <div className="flex gap-1 flex-wrap">
                {wf.phases.map((pid, i) => {
                  return (
                    <span key={i} onClick={() => setExpandedPhase(expandedPhase === pid ? null : pid)}
                      className={cn("text-[9px] px-1.5 py-0.5 rounded cursor-pointer border",
                        expandedPhase === pid ? "bg-primary/12 border-primary/30 text-foreground" : "bg-secondary border-border text-muted-foreground"
                      )}>{i + 1}. {pid}</span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="bg-card rounded-lg p-3 border border-border">
          <h3 className="text-[11px] text-muted-foreground/50 uppercase tracking-wide mb-2 font-semibold">Schedules ({config.schedules.length})</h3>
          {config.schedules.map((s) => (
            <div key={s.id} className="p-1.5 px-2 mb-1 bg-background rounded border border-border">
              <div className="flex justify-between items-center">
                <span className="font-semibold text-[11px] text-foreground">{s.id}</span>
                {!s.enabled && <span className="text-[8px] text-chart-5 bg-chart-5/10 px-1 py-px rounded">disabled</span>}
              </div>
              <div className="flex justify-between mt-0.5">
                <span className="text-[10px] text-muted-foreground">{cronToHuman(s.cron)}</span>
                <span className="text-[9px] text-muted-foreground/40 font-mono">{s.cron}</span>
              </div>
              <div className="text-[9px] text-muted-foreground mt-px">→ {s.workflow_ref}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="bg-card rounded-lg p-3 border border-border">
          <h3 className="text-[11px] text-muted-foreground/50 uppercase tracking-wide mb-2 font-semibold">Agents ({config.agents.length})</h3>
          {config.agents.map((a) => (
            <div key={a.name} onClick={() => setExpandedAgent(expandedAgent === a.name ? null : a.name)}
              className={cn("p-2 mb-1 bg-background rounded cursor-pointer border", expandedAgent === a.name ? "border-primary/30" : "border-border")}>
              <div className="flex justify-between items-center">
                <span className="text-foreground font-semibold text-[11px]">{a.name}</span>
                <div className="flex gap-1 items-center">
                  <span className="text-[9px] text-muted-foreground">{a.model.replace("kimi-code/", "")}</span>
                  <span className="text-[9px] text-muted-foreground/40 bg-secondary px-1 py-px rounded">{a.tool}</span>
                </div>
              </div>
              {a.mcp_servers.length > 0 && (
                <div className="flex gap-1 mt-1">
                  {a.mcp_servers.map((s) => (
                    <span key={s} className="text-[8px] px-1 py-px rounded bg-secondary text-muted-foreground">{s}</span>
                  ))}
                </div>
              )}
              {expandedAgent === a.name && a.system_prompt && (
                <div className="mt-1.5 p-2 bg-card rounded text-[10px] text-muted-foreground font-mono whitespace-pre-wrap max-h-[200px] overflow-auto leading-[14px]">
                  {a.system_prompt}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="bg-card rounded-lg p-3 border border-border">
          <h3 className="text-[11px] text-muted-foreground/50 uppercase tracking-wide mb-2 font-semibold">Phases ({config.phases.length})</h3>
          {config.phases.map((ph) => (
            <div key={ph.id} onClick={() => setExpandedPhase(expandedPhase === ph.id ? null : ph.id)}
              className={cn("p-1.5 mb-0.5 bg-background rounded cursor-pointer border",
                expandedPhase === ph.id ? "border-primary/30" : "border-border"
              )}>
              <div className="flex justify-between items-center">
                <span className="font-semibold text-[10px] text-foreground">{ph.id}</span>
                <span className="text-[9px] text-muted-foreground/30">
                  {ph.mode === "command" ? (ph.command ? `$ ${ph.command} ${ph.command_args.join(" ")}` : "cmd") : (ph.agent || "agent")}
                </span>
              </div>
              {expandedPhase === ph.id && (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {ph.mode === "command" && ph.command && (
                    <div className="font-mono bg-card p-1.5 rounded mb-1">
                      <span className="text-primary">$ {ph.command} {ph.command_args.join(" ")}</span>
                      {ph.cwd_mode && <div className="text-muted-foreground/30 text-[9px]">cwd: {ph.cwd_mode}</div>}
                      {ph.timeout_secs && <div className="text-muted-foreground/30 text-[9px]">timeout: {ph.timeout_secs}s</div>}
                    </div>
                  )}
                  {ph.directive && (
                    <div className="whitespace-pre-wrap font-mono bg-card p-1.5 rounded max-h-[150px] overflow-auto leading-[14px] text-[9px]">
                      {ph.directive}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

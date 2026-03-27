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
      .slice(0, 3);
  }, [eventsByProjectRoot, projects]);

  if (selected) {
    return (
      <ProjectDetail
        project={selected}
        events={eventsByProjectRoot.get(selected.root) ?? []}
        onBack={() => setSelectedRoot(null)}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="max-w-[1600px] mx-auto p-6 space-y-8">
        {/* KPI Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KPICard label="Total Projects" value={projects.length} />
          <KPICard label="Active Agents" value={`${totalAgents}/${totalPool}`} />
          <KPICard label="Total Tasks" value={totalTasks} />
          <KPICard label="Fleet Queue" value={totalQueue} tone={totalQueue > 20 ? "warning" : "default"} />
        </div>

        {/* Attention Lane */}
        {attentionProjects.length > 0 && (
          <section className="space-y-4">
            <div className="flex items-end justify-between px-1">
              <div>
                <h3 className="text-sm font-bold uppercase tracking-widest text-primary/80">Attention Required</h3>
                <p className="text-sm text-muted-foreground mt-1">Projects requiring immediate operator intervention.</p>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {attentionProjects.map(({ project, state }) => (
                <button
                  key={`${project.root}:attention`}
                  onClick={() => setSelectedRoot(project.root)}
                  className="group relative flex flex-col p-5 text-left rounded-2xl border border-white/5 bg-white/5 hover:bg-white/10 transition-all duration-300"
                >
                  <div className="flex justify-between items-start mb-4">
                    <span className="text-base font-bold text-foreground group-hover:text-primary transition-colors">{project.name}</span>
                    <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border", stateToneClasses(state.tone))}>
                      {state.label}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2 flex-1 mb-4">{state.summary}</p>
                  <div className="pt-4 border-t border-white/5 flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">{state.action}</span>
                    <span className="text-muted-foreground">Open →</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Charts & System Panel */}
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-6">
            <div className="rounded-2xl border border-white/5 bg-card/20 p-6">
              <h3 className="text-sm font-bold text-foreground mb-6">Project Activity & Task Distribution</h3>
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={taskBarData} barSize={20}>
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "#6b7280", fontSize: 12 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: "#6b7280", fontSize: 12 }} />
                    <Tooltip 
                      cursor={{ fill: "rgba(255,255,255,0.05)" }}
                      contentStyle={{ background: "#0f1115", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "12px" }}
                    />
                    <Bar dataKey="done" stackId="a" fill={TASK_COLORS.done} radius={[0, 0, 0, 0]} />
                    <Bar dataKey="ready" stackId="a" fill={TASK_COLORS.ready} />
                    <Bar dataKey="in_progress" stackId="a" fill={TASK_COLORS.in_progress} />
                    <Bar dataKey="blocked" stackId="a" fill={TASK_COLORS.blocked} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Project List */}
            <div className="rounded-2xl border border-white/5 bg-card/20 overflow-hidden">
              <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
                <h3 className="text-sm font-bold text-foreground">All Fleet Projects</h3>
                <span className="text-xs text-muted-foreground">{projects.length} connected</span>
              </div>
              <div className="divide-y divide-white/5">
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
          </div>

          <aside className="space-y-6">
            {globalAoInfo && <GlobalAoPanel info={globalAoInfo} />}
            
            <div className="rounded-2xl border border-white/5 bg-card/20 p-6">
              <h3 className="text-sm font-bold text-foreground mb-4">Daemon Health</h3>
              <div className="h-[180px] flex items-center justify-center">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={statusData} dataKey="value" cx="50%" cy="50%" innerRadius={50} outerRadius={70} stroke="none">
                      {statusData.map((d) => (<Cell key={d.name} fill={STATUS_COLORS[d.name] || "#333"} />))}
                    </Pie>
                    <Tooltip contentStyle={{ background: "#0f1115", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "12px" }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                {statusData.map((d) => (
                  <div key={d.name} className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full" style={{ background: STATUS_COLORS[d.name] }} />
                    <span className="text-muted-foreground capitalize">{d.name}</span>
                    <span className="ml-auto font-medium">{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function KPICard({ label, value, tone = "default" }: { label: string; value: string | number; tone?: "default" | "warning" | "critical" }) {
  const toneClass = tone === "warning" ? "text-chart-4" : tone === "critical" ? "text-chart-5" : "text-primary";
  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-6 backdrop-blur-sm">
      <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">{label}</div>
      <div className={cn("text-2xl font-bold", toneClass)}>{value}</div>
    </div>
  );
}

function GlobalAoPanel({ info }: { info: GlobalAoInfo }) {
  const configuredProviders = info.providers.filter((provider) => provider.configured);
  const templates = info.workflow_templates.slice(0, 6);

  return (
    <div className="rounded-2xl border border-white/5 bg-card/20 p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-bold text-foreground mb-1">AO Home</h3>
          <div className="font-mono text-[11px] text-muted-foreground break-all">{info.ao_home}</div>
        </div>
      </div>

      <div className="grid gap-3">
        <MiniStat label="Sync" value={info.sync.configured ? "Online" : "Local"} tone={info.sync.configured ? "text-chart-1" : "text-muted-foreground"} />
        <MiniStat label="Runner" value={info.agent_runner_token_configured ? "Active" : "None"} tone={info.agent_runner_token_configured ? "text-chart-1" : "text-muted-foreground"} />
        <MiniStat label="Providers" value={`${configuredProviders.length}/${info.providers.length}`} tone="text-foreground" />
      </div>

      <div className="space-y-4">
        <div>
          <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 mb-2">Providers</h4>
          <div className="space-y-2">
            {info.providers.slice(0, 3).map((provider) => (
              <div key={provider.name} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{provider.name}</span>
                <span className={cn("px-1.5 py-0.5 rounded-[4px] text-[9px] font-bold", provider.configured ? "bg-chart-1/10 text-chart-1" : "bg-white/5 text-muted-foreground")}>
                  {provider.configured ? "ON" : "OFF"}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 mb-2">Logs</h4>
          <div className="space-y-2">
            {info.logs.slice(0, 2).map((log) => (
              <div key={log.name} className="text-[11px]">
                <div className="flex justify-between text-muted-foreground mb-1">
                  <span>{log.name}</span>
                  <span>{formatBytes(log.size_bytes)}</span>
                </div>
                {log.recent_lines.length > 0 && (
                  <div className="bg-black/20 rounded p-2 font-mono text-[10px] text-muted-foreground/80 truncate">
                    {log.recent_lines[log.recent_lines.length - 1]}
                  </div>
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
    <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-white/5 border border-white/5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-xs font-bold", tone)}>{value}</span>
    </div>
  );
}

function shortUrl(value?: string) {
  if (!value) return "Unknown";
  try { return new URL(value).host; } catch { return value; }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(value?: number) {
  if (!value) return "unknown";
  return new Date(value).toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
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
      action: "Inspect failures", score: 5,
    };
  }

  if (blockedTasks > 0 || queueDepth > 25) {
    return {
      tone: "blocked" as const, label: "Needs intervention",
      summary: blockedTasks > 0 ? `${blockedTasks} blocked tasks stopping progress.` : `${queueDepth} queued subjects building up.`,
      action: "Unblock tasks", score: 4,
    };
  }

  if (!project.health?.healthy || errorCount > 0 || utilization > 85) {
    return {
      tone: "degraded" as const, label: "Watch closely",
      summary: errorCount > 0 ? `${errorCount} recent errors detected.` : utilization > 85 ? `High utilization: ${Math.round(utilization)}%.` : "Noisy health signals.",
      action: "Check stream", score: 3,
    };
  }

  if (activeRuns > 0 || (project.health?.active_agents ?? 0) > 0) {
    return {
      tone: "healthy" as const, label: "Operating normally",
      summary: activeRuns > 0 ? `${activeRuns} active workflows progressing.` : "Agents active and healthy.",
      action: "Monitor runs", score: 2,
    };
  }

  return { tone: "idle" as const, label: "Ready", summary: "Project available for new work.", action: "Start operation", score: 1 };
}

function stateToneClasses(tone: ProjectStateTone) {
  if (tone === "failed") return "border-chart-5/40 bg-chart-5/10 text-chart-5";
  if (tone === "blocked") return "border-chart-4/40 bg-chart-4/10 text-chart-4";
  if (tone === "degraded") return "border-primary/40 bg-primary/10 text-primary";
  if (tone === "healthy") return "border-chart-1/40 bg-chart-1/10 text-chart-1";
  return "border-white/10 bg-white/5 text-muted-foreground";
}


function OverviewProjectRow({ project: p, events, onClick }: { project: FleetProject; events: StreamEvent[]; onClick: () => void }) {
  const status = p.health?.status || "offline";
  const state = getProjectState(p, events);
  const queueDepth = p.health?.queued_tasks || 0;
  const utilization = Math.round(p.health?.pool_utilization_percent || 0);

  return (
    <button
      onClick={onClick}
      className="w-full grid grid-cols-[1fr_120px_160px_100px] items-center gap-6 px-6 py-5 text-left hover:bg-white/[0.03] transition-colors group"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <span className="text-base font-bold text-foreground group-hover:text-primary transition-colors">{p.name}</span>
          <span className="text-xs text-muted-foreground font-medium">{status}</span>
        </div>
        <div className="mt-1 text-sm text-muted-foreground line-clamp-1">{state.summary}</div>
      </div>

      <div className="flex justify-center">
        <span className={cn("px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider border", stateToneClasses(state.tone))}>
          {state.label}
        </span>
      </div>

      <div className="space-y-2">
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Queue</span>
          <span className={cn("font-bold", queueDepth > 10 ? "text-chart-4" : "text-foreground")}>{queueDepth}</span>
        </div>
        <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
          <div 
            className={cn("h-full rounded-full transition-all duration-500", utilization > 80 ? "bg-chart-4" : "bg-primary")}
            style={{ width: `${utilization}%` }}
          />
        </div>
      </div>

      <div className="text-right text-xs font-bold text-muted-foreground group-hover:text-primary transition-colors">
        OPEN →
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
    if (p.workflows.length === 0) return null;
    return {
      type: "active-runs",
      workflowIds: [...new Set(p.workflows.map((wf) => wf.id).filter(Boolean))],
      workflowRefs: [...new Set(p.workflows.map((wf) => wf.workflow_ref).filter(Boolean))],
      taskIds: [...new Set(p.workflows.map((wf) => wf.task_id).filter((taskId) => taskId && taskId !== "cron"))],
      label: "ACTIVE RUNS",
    };
  }, [p.workflows]);

  const liveStreamParams = useMemo(() => {
    if (streamFilter.type === "workflow") return { workflow: streamFilter.value, run: null };
    return { workflow: null, run: null };
  }, [streamFilter]);

  useEffect(() => {
    invoke<ProjectConfig>("get_project_config", { projectRoot: p.root }).then(setConfig).catch(() => {});
    invoke<TaskInfo[]>("get_task_list", { projectRoot: p.root }).then(setTaskList).catch(() => {});
    invoke<CommitInfo[]>("get_recent_commits", { projectRoot: p.root }).then(setCommits).catch(() => {});
  }, [p.root]);

  useEffect(() => {
    if (viewMode !== "stream") return;
    setStreamEvents((prev) => {
      if (!streamLoading && !streamError && prev.length > 0) return prev;
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
        if (!disposed) setStreamEvents(mergeStreamEvents(seedEvents, recent, PROJECT_DETAIL_MAX_EVENTS));
      } catch (error) { nextError = `Recent events unavailable: ${String(error)}`; }

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
      if (activeChannelId) invoke("stop_filtered_stream", { channelId: activeChannelId }).catch(() => {});
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

  const filtered = useMemo(() => {
    const query = textFilter.trim().toLowerCase();
    return streamEvents.filter((event) => {
      if (!matchesLevelFilter(event, levelFilter) || !matchesStreamFilter(event, streamFilter)) return false;
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

  return (
    <div className="h-full flex flex-col bg-background/50">
      <header className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="p-2 -ml-2 rounded-lg hover:bg-white/5 transition-colors text-muted-foreground hover:text-foreground">
            ←
          </button>
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-3">
              {p.name}
              <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border", 
                p.health?.status === "running" ? "border-chart-1/30 bg-chart-1/10 text-chart-1" : "border-white/10 bg-white/5 text-muted-foreground")}>
                {p.health?.status || "offline"}
              </span>
            </h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <DetailTab label="Stream" active={viewMode === "stream"} onClick={() => setViewMode("stream")} />
          <DetailTab label="Config" active={viewMode === "config"} onClick={() => setViewMode("config")} />
          <DetailTab label="Tasks" active={viewMode === "tasks"} onClick={() => setViewMode("tasks")} count={taskList.length} />
          <DetailTab label="Commits" active={viewMode === "commits"} onClick={() => setViewMode("commits")} />
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden">
        {viewMode === "config" && config ? <ConfigView config={config} /> :
         viewMode === "tasks" ? <TasksView tasks={taskList} /> :
         viewMode === "commits" ? <CommitsView commits={commits} /> :
         <div className="h-full flex">
           <aside className="w-64 border-r border-white/5 bg-card/10 overflow-y-auto p-4 space-y-6">
             <SidebarSection title="General">
               <SidebarItem label="All Events" active={streamFilter.type === "all"} count={projectEvents.length} onClick={() => setStreamFilter({ type: "all" })} />
             </SidebarSection>

             {workflowRefs.size > 0 && (
               <SidebarSection title="Workflows">
                 {[...workflowRefs].map(([ref, { count, active }]) =>
                   <SidebarItem key={ref} label={ref} active={streamFilter.type === "workflow" && streamFilter.value === ref} count={count} 
                     tone={active ? "success" : "default"} onClick={() => setStreamFilter({ type: "workflow", value: ref })} />
                 )}
               </SidebarSection>
             )}

             {p.workflows.length > 0 && (
               <SidebarSection title="Active Runs">
                 {activeRunsFilter && <SidebarItem label="All Active" active={streamFilter.type === "active-runs"} count={p.workflows.length} 
                   tone="success" onClick={() => setStreamFilter(activeRunsFilter)} />}
                 {p.workflows.map((wf) => (
                   <button key={wf.id} onClick={() => setStreamFilter({ type: "run", workflowId: wf.id, workflowRef: wf.workflow_ref, label: wf.workflow_ref })}
                     className={cn("w-full text-left p-2 rounded-lg text-xs transition-colors", 
                       streamFilter.type === "run" && streamFilter.workflowId === wf.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-white/5")}>
                     <div className="font-bold truncate">{wf.workflow_ref}</div>
                     <div className="opacity-60 truncate">{wf.current_phase}</div>
                   </button>
                 ))}
               </SidebarSection>
             )}
           </aside>

           <section className="flex-1 flex flex-col min-w-0">
             <div className="h-12 px-4 border-b border-white/5 flex items-center justify-between gap-4 bg-card/5 backdrop-blur-sm">
               <div className="flex items-center gap-3">
                 <span className="text-xs font-bold text-foreground/80 uppercase tracking-widest">
                   {streamFilter.type === "all" ? "Live Stream" : streamFilter.label || (streamFilter.type === "workflow" ? streamFilter.value : "Stream")}
                 </span>
                 <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground">{filtered.length} events</span>
               </div>
               
               <div className="flex items-center gap-2">
                 <input value={textFilter} onChange={(e) => setTextFilter(e.target.value)} placeholder="Search logs..." 
                   className="h-8 w-48 bg-white/5 border border-white/5 rounded-md px-3 text-xs outline-none focus:border-primary/50 transition-colors" />
                 <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}
                   className="h-8 bg-white/5 border border-white/5 rounded-md px-2 text-xs outline-none">
                   <option value="all">All Levels</option>
                   <option value="error">Error</option>
                   <option value="warn">Warn</option>
                   <option value="info">Info</option>
                 </select>
                 <select value={groupMode} onChange={(e) => setGroupMode(e.target.value as LogGroupMode)}
                   className="h-8 bg-white/5 border border-white/5 rounded-md px-2 text-xs outline-none">
                   <option value="conversation">Conversation</option>
                   <option value="workflow">Workflow</option>
                   <option value="flat">Flat</option>
                 </select>
               </div>
             </div>

             <div ref={logRef} onScroll={handleLogScroll} className="flex-1 overflow-y-auto custom-scrollbar p-4 font-mono">
               {streamError && <div className="p-3 mb-4 rounded-lg bg-chart-5/10 border border-chart-5/20 text-xs text-chart-5">{streamError}</div>}
               {filtered.length === 0 ? (
                 <div className="h-full flex items-center justify-center text-muted-foreground/30 text-sm">
                   {streamLoading ? "Establishing stream..." : "No events match your criteria"}
                 </div>
               ) : (
                 <LogEventList events={filtered} groupMode={groupMode} onWorkflowClick={(ref) => setStreamFilter({ type: "workflow", value: ref })} />
               )}
               <div ref={bottomRef} />
             </div>
           </section>
         </div>
        }
      </main>
    </div>
  );
}

function DetailTab({ label, active, onClick, count }: { label: string; active: boolean; onClick: () => void; count?: number }) {
  return (
    <button onClick={onClick} className={cn("px-4 py-2 text-sm font-medium transition-all relative", 
      active ? "text-primary" : "text-muted-foreground hover:text-foreground")}>
      <span className="flex items-center gap-2">
        {label}
        {count !== undefined && <span className="text-[10px] px-1.5 rounded-full bg-white/5 border border-white/5">{count}</span>}
      </span>
      {active && <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary rounded-full" />}
    </button>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="px-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">{title}</h3>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function SidebarItem({ label, active, count, tone, onClick }: { label: string; active: boolean; count: number; tone?: "success" | "default"; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cn("w-full flex items-center gap-3 px-2 py-1.5 rounded-lg text-sm transition-all", 
      active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-white/5 hover:text-foreground")}>
      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", 
        active ? "bg-primary shadow-[0_0_8px_rgba(var(--la-primary),0.6)]" : tone === "success" ? "bg-chart-1" : "bg-white/20")} />
      <span className="flex-1 truncate text-left font-medium">{label}</span>
      <span className="text-[10px] font-bold opacity-40">{count}</span>
    </button>
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

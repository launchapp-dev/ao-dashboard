import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";
import type { FleetProject, StreamEvent, ProjectConfig, TaskInfo, CommitInfo, GlobalAoInfo } from "./types";

const STATUS_COLORS: Record<string, string> = {
  running: "#22c55e", stopped: "#6b7280", crashed: "#ef4444", offline: "#374151",
};

const TASK_COLORS: Record<string, string> = {
  done: "#22c55e", ready: "#3b82f6", backlog: "#6b7280", blocked: "#eab308",
  in_progress: "#a78bfa", cancelled: "#ef4444", on_hold: "#f97316",
};

interface Props { projects: FleetProject[]; events: StreamEvent[]; globalAoInfo?: GlobalAoInfo | null; }
type StreamFilter =
  | { type: "all" }
  | { type: "workflow"; value: string }
  | { type: "run"; taskId?: string; workflowRef: string; label: string };
const PROJECT_DETAIL_MAX_EVENTS = 4000;

function getEventKey(event: StreamEvent, index: number) {
  return `${event.project_root ?? event.project}:${event.ts}:${event.cat}:${event.task_id ?? ""}:${event.phase_id ?? ""}:${index}`;
}

function getEventIdentity(event: StreamEvent) {
  return `${event.project_root ?? event.project}:${event.ts}:${event.cat}:${event.msg}:${event.task_id ?? ""}:${event.phase_id ?? ""}:${event.workflow_ref ?? ""}`;
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

  return (
    <div className={cn("h-[calc(100vh-60px)]", selected ? "overflow-hidden" : "overflow-auto p-5")}>
      {!selected ? (
        <>
          <div className="grid grid-cols-6 gap-3 mb-5">
            <KPI label="Projects" value={projects.length} color="text-primary" />
            <KPI label="Agents" value={`${totalAgents}/${totalPool}`} color="text-chart-1" />
            <KPI label="Workflows" value={totalWorkflows} color="text-accent" />
            <KPI label="Queued" value={totalQueue} color={totalQueue > 20 ? "text-chart-4" : "text-muted-foreground"} />
            <KPI label="Tasks Done" value={totalDone} color="text-chart-1" />
            <KPI label="Total Tasks" value={totalTasks} color="text-primary" />
          </div>

          {globalAoInfo && <GlobalAoPanel info={globalAoInfo} />}

          <div className="grid grid-cols-[200px_1fr] gap-5 mb-5">
            <div className="bg-card rounded-xl p-4 border border-border">
              <h3 className="text-xs text-muted-foreground mb-2 uppercase tracking-wide font-semibold">Daemon Status</h3>
              <ResponsiveContainer width="100%" height={150}>
                <PieChart>
                  <Pie data={statusData} dataKey="value" cx="50%" cy="50%" innerRadius={30} outerRadius={55}>
                    {statusData.map((d) => (<Cell key={d.name} fill={STATUS_COLORS[d.name] || "#333"} />))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "hsl(225 35% 7%)", border: "1px solid hsl(225 20% 15%)", borderRadius: 6 }} />
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
                  <XAxis dataKey="name" tick={{ fill: "#666", fontSize: 10 }} />
                  <YAxis tick={{ fill: "#666", fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: "hsl(225 35% 7%)", border: "1px solid hsl(225 20% 15%)", borderRadius: 6, fontSize: 12 }} />
                  <Bar dataKey="done" stackId="a" fill={TASK_COLORS.done} />
                  <Bar dataKey="ready" stackId="a" fill={TASK_COLORS.ready} />
                  <Bar dataKey="in_progress" stackId="a" fill={TASK_COLORS.in_progress} />
                  <Bar dataKey="backlog" stackId="a" fill={TASK_COLORS.backlog} />
                  <Bar dataKey="blocked" stackId="a" fill={TASK_COLORS.blocked} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {projects.map((p) => (
              <ProjectCard
                key={p.root}
                project={p}
                events={eventsByProjectRoot.get(p.root) ?? []}
                onClick={() => setSelectedRoot(p.root)}
              />
            ))}
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

function KPI({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="bg-card rounded-lg p-3 border-l-[3px] border-border" style={{ borderLeftColor: "currentColor" }}>
      <div className={cn("text-xl font-bold", color)}>{value}</div>
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
          <div className="text-[11px] text-muted-foreground/60 font-mono mt-1">{info.ao_home}</div>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <MiniStat label="Sync" value={info.sync.configured ? "On" : "Off"} tone={info.sync.configured ? "text-chart-1" : "text-chart-4"} />
          <MiniStat label="Runner Token" value={info.agent_runner_token_configured ? "Set" : "Missing"} tone={info.agent_runner_token_configured ? "text-chart-1" : "text-muted-foreground"} />
          <MiniStat label="Providers" value={`${configuredProviders.length}/${info.providers.length}`} tone="text-primary" />
          <MiniStat label="Templates" value={info.workflow_templates.length} tone="text-accent" />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div className="bg-background rounded-lg border border-border p-3 min-w-0">
          <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wide font-semibold mb-2">Sync</div>
          <div className="text-sm font-semibold text-foreground">{info.sync.server ? shortUrl(info.sync.server) : "Not configured"}</div>
          <div className="text-[11px] text-muted-foreground mt-1">
            {info.sync.project_id ? `Project ${info.sync.project_id}` : "No linked project"}
          </div>
          <div className="text-[10px] text-muted-foreground/50 mt-2">
            Last sync {info.sync.last_synced_at ? info.sync.last_synced_at : "not recorded"}
          </div>
        </div>

        <div className="bg-background rounded-lg border border-border p-3 min-w-0">
          <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wide font-semibold mb-2">Providers</div>
          <div className="flex flex-col gap-1.5">
            {info.providers.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">No credential providers</div>
            ) : (
              info.providers.slice(0, 6).map((provider) => (
                <div key={provider.name} className="flex items-center gap-2 text-[11px] min-w-0">
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", provider.configured ? "bg-chart-1" : "bg-muted-foreground/30")} />
                  <span className="font-semibold text-foreground shrink-0">{provider.name}</span>
                  <span className="text-muted-foreground/60 truncate">{shortUrl(provider.base_url)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-background rounded-lg border border-border p-3 min-w-0">
          <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wide font-semibold mb-2">Global Workflows</div>
          <div className="flex flex-col gap-2">
            {templates.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">No shared workflow templates</div>
            ) : (
              templates.map((workflow) => (
                <div key={`${workflow.source_file}:${workflow.id}`} className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-accent truncate">{workflow.id}</span>
                    <span className="text-[9px] text-muted-foreground/40 shrink-0">{workflow.phase_count} phases</span>
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
          <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wide font-semibold mb-2">Top-Level Logs</div>
          <div className="flex flex-col gap-2">
            {info.logs.map((log) => (
              <div key={log.name} className="min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-foreground">{log.name}</span>
                  <span className="text-[9px] text-muted-foreground/40 shrink-0">
                    {log.exists ? `${formatBytes(log.size_bytes)} · ${formatTimestamp(log.modified_at_ms)}` : "missing"}
                  </span>
                </div>
                {log.recent_lines.length > 0 ? (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {log.recent_lines.map((line, index) => (
                      <div key={`${log.name}:${index}`} className="text-[10px] text-muted-foreground/75 font-mono truncate">
                        {line}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[10px] text-muted-foreground/50 mt-1">No recent lines</div>
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

function ProjectCard({ project: p, events, onClick }: { project: FleetProject; events: StreamEvent[]; onClick: () => void }) {
  const status = p.health?.status || "offline";
  const color = STATUS_COLORS[status] || "#333";
  const recentEvents = events.slice(-3);

  return (
    <div
      onClick={onClick}
      className="bg-card rounded-lg p-3.5 cursor-pointer border transition-colors hover:border-primary/50"
      style={{ borderColor: `${color}40` }}
    >
      <div className="flex justify-between items-center mb-2">
        <span className="font-bold text-[13px] text-foreground">{p.name}</span>
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded" style={{ background: color, color: "#000" }}>{status}</span>
      </div>

      <div className="grid grid-cols-3 gap-1 text-[11px] mb-2">
        <div><span className="text-muted-foreground">agents </span><span className="font-semibold">{p.health?.active_agents || 0}/{p.health?.pool_size || 0}</span></div>
        <div><span className="text-muted-foreground">queue </span><span className={cn("font-semibold", (p.health?.queued_tasks || 0) > 10 && "text-chart-4")}>{p.health?.queued_tasks || 0}</span></div>
        <div><span className="text-muted-foreground">wf </span><span className="font-semibold text-accent">{p.workflows.length}</span></div>
      </div>

      <div className="h-[3px] bg-secondary rounded-full overflow-hidden mb-1.5">
        <div className="h-full transition-all duration-500" style={{
          width: `${p.health?.pool_utilization_percent || 0}%`,
          background: (p.health?.pool_utilization_percent || 0) > 80 ? "#22c55e" : "#3b82f6",
        }} />
      </div>

      {p.workflows.length > 0 && (
        <div className="text-[10px] text-muted-foreground">
          {p.workflows.slice(0, 2).map((wf, i) => (
            <div key={`${wf.id}:${i}`} className="flex gap-1 items-center">
              <span className="w-[5px] h-[5px] rounded-full bg-primary inline-block animate-pulse" />
              <span className="text-accent">{wf.workflow_ref}</span>
              <span className="text-muted-foreground/50">→ {wf.current_phase}</span>
            </div>
          ))}
          {p.workflows.length > 2 && <div className="text-muted-foreground/40">+{p.workflows.length - 2} more</div>}
        </div>
      )}

      {p.tasks && p.tasks.total > 0 && (
        <div className="mt-1.5 flex h-[3px] rounded-full overflow-hidden bg-secondary">
          {p.tasks.done > 0 && <div style={{ width: `${(p.tasks.done / p.tasks.total) * 100}%`, background: TASK_COLORS.done }} />}
          {p.tasks.ready > 0 && <div style={{ width: `${(p.tasks.ready / p.tasks.total) * 100}%`, background: TASK_COLORS.ready }} />}
          {p.tasks.backlog > 0 && <div style={{ width: `${(p.tasks.backlog / p.tasks.total) * 100}%`, background: TASK_COLORS.backlog }} />}
          {p.tasks.blocked > 0 && <div style={{ width: `${(p.tasks.blocked / p.tasks.total) * 100}%`, background: TASK_COLORS.blocked }} />}
        </div>
      )}

      {recentEvents.length > 0 && (
        <div className="mt-1.5 text-[9px] max-h-[36px] overflow-hidden">
          {recentEvents.map((e, i) => (
            <div key={getEventKey(e, i)} className={cn(
              "whitespace-nowrap overflow-hidden text-ellipsis leading-[12px]",
              e.level === "error" ? "text-chart-5" : e.level === "warn" ? "text-chart-4" : "text-muted-foreground/40"
            )}>{e.msg.slice(0, 40)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectDetail({ project: p, events, onBack }: { project: FleetProject; events: StreamEvent[]; onBack: () => void }) {
  const [streamFilter, setStreamFilter] = useState<StreamFilter>({ type: "all" });
  const [levelFilter, setLevelFilter] = useState("all");
  const [textFilter, setTextFilter] = useState("");
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

  const liveStreamParams = useMemo(() => {
    if (streamFilter.type === "workflow") {
      return {
        workflow: streamFilter.value,
        run: null,
      };
    }

    if (streamFilter.type === "run") {
      return {
        workflow: streamFilter.taskId ? null : streamFilter.workflowRef,
        run: streamFilter.taskId ?? null,
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
    setStreamEvents(events.slice(-PROJECT_DETAIL_MAX_EVENTS));
    setStreamError(null);
  }, [p.root]);

  useEffect(() => {
    if (viewMode !== "stream") return;

    let disposed = false;
    let activeChannelId: string | null = null;
    let unlisten: (() => void) | null = null;

    setStreamLoading(true);
    setStreamError(null);
    setStreamEvents([]);

    const streamRequest = {
      projectRoot: p.root,
      workflow: liveStreamParams.workflow,
      run: liveStreamParams.run,
      cat: null,
      level: levelFilter === "all" ? null : levelFilter,
    };

    const connect = async () => {
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

        const recent = await invoke<StreamEvent[]>("get_filtered_events", streamRequest);
        if (disposed) return;
        setStreamEvents((prev) => mergeStreamEvents(recent, prev, PROJECT_DETAIL_MAX_EVENTS));
      } catch (error) {
        if (!disposed) {
          setStreamError(String(error));
        }
      } finally {
        if (!disposed) {
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
  }, [levelFilter, liveStreamParams, p.root, viewMode]);

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
      if (query) {
        const haystack = `${event.msg} ${event.cat}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [streamEvents, textFilter]);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [filtered.length, autoScroll]);

  const handleLogScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  const tabBtn = (mode: typeof viewMode, label: string, extra?: string) => (
    <button onClick={() => setViewMode(mode)} className={cn(
      "px-3 py-1 rounded text-[11px] border transition-colors cursor-pointer",
      viewMode === mode ? "bg-primary/20 border-primary/40 text-foreground" : "bg-transparent border-border text-muted-foreground hover:text-foreground"
    )}>{label}{extra || ""}</button>
  );

  const sidebarItem = (label: string, count: number, active: boolean, onClick: () => void, dot?: string) => (
    <div onClick={onClick} className={cn(
      "flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer text-[11px]",
      active ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground"
    )}>
      {dot && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />}
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
      <span className="text-[9px] text-muted-foreground/50 shrink-0">{count}</span>
    </div>
  );

  return (
    <div className="h-full w-full flex flex-col overflow-hidden">
      <div className="shrink-0 px-5 pt-3">
        <button onClick={onBack} className="mb-3 px-3 py-1.5 rounded border border-border text-muted-foreground text-xs cursor-pointer hover:text-foreground hover:border-primary/40 transition-colors">
          ← Back to Fleet
        </button>

        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-xl font-bold">{p.name}</h2>
          <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded" style={{
            background: STATUS_COLORS[p.health?.status || "offline"], color: "#000",
          }}>{p.health?.status || "offline"}</span>
        </div>

        <div className="grid grid-cols-5 gap-2.5 mb-3">
          <KPI label="Agents" value={`${p.health?.active_agents || 0}/${p.health?.pool_size || 0}`} color="text-chart-1" />
          <KPI label="Queue" value={p.health?.queued_tasks || 0} color="text-chart-4" />
          <KPI label="Workflows" value={p.workflows.length} color="text-accent" />
          <KPI label="Tasks Done" value={p.tasks?.done || 0} color="text-chart-1" />
          <KPI label="Total Tasks" value={p.tasks?.total || 0} color="text-primary" />
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
      <div className="flex-1 grid grid-cols-[180px_minmax(0,1fr)] gap-2.5 px-5 pb-3 min-h-0 overflow-hidden">
        <div className="bg-card rounded-lg p-2.5 overflow-auto min-w-0 border border-border">
          {sidebarItem("All Events", projectEvents.length, streamFilter.type === "all", () => setStreamFilter({ type: "all" }), "#3b82f6")}

          {workflowRefs.size > 0 && (
            <>
              <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wide pt-2.5 px-2 pb-1 font-semibold">Workflows</div>
              {[...workflowRefs].map(([ref, { count, active }]) =>
                sidebarItem(ref, count, streamFilter.type === "workflow" && streamFilter.value === ref,
                  () => setStreamFilter({ type: "workflow", value: ref }),
                  active ? "#22c55e" : "#6b7280")
              )}
            </>
          )}

          {modelNames.size > 0 && (
            <>
              <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wide pt-2.5 px-2 pb-1 font-semibold">Models</div>
              {[...modelNames].map(([name, count]) => (
                <div key={name} className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{name.replace("kimi-code/", "")}</span>
                  <span className="text-[9px] text-muted-foreground/50">{count}</span>
                </div>
              ))}
            </>
          )}

          {p.workflows.length > 0 && (
            <>
              <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wide pt-2.5 px-2 pb-1 font-semibold">Active Runs</div>
              {p.workflows.map((wf) => (
                <div
                  key={wf.id}
                  onClick={() => setStreamFilter({
                    type: "run",
                    taskId: wf.task_id !== "cron" ? wf.task_id : undefined,
                    workflowRef: wf.workflow_ref,
                    label: `${wf.workflow_ref} → ${wf.current_phase}`,
                  })}
                  className={cn(
                    "px-2 py-1 text-[10px] cursor-pointer rounded",
                    streamFilter.type === "run" && streamFilter.label === `${wf.workflow_ref} → ${wf.current_phase}` ? "bg-primary/15" : ""
                  )}
                >
                  <div className="flex items-center gap-1">
                    <span className="w-[5px] h-[5px] rounded-full bg-primary animate-pulse" />
                    <span className="text-accent font-semibold">{wf.workflow_ref}</span>
                  </div>
                  <div className="text-muted-foreground/50 pl-[9px]">
                    {wf.current_phase} ({wf.phase_progress})
                    {wf.task_id !== "cron" && <span className="text-muted-foreground/30"> · {wf.task_id}</span>}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="bg-card rounded-lg flex flex-col min-h-0 min-w-0 overflow-hidden border border-border">
          <div className="flex gap-2 px-3 py-2.5 border-b border-border shrink-0 items-center">
            <span className="text-[11px] text-muted-foreground font-semibold">
              {streamFilter.type === "all" ? "ALL" : streamFilter.type === "run" ? streamFilter.label : streamFilter.value?.toUpperCase()}
            </span>
            <span className="text-[10px] text-muted-foreground/40">{filtered.length} events</span>
            <span className={cn(
              "rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
              streamLoading ? "bg-accent/10 text-accent" : streamError ? "bg-chart-5/10 text-chart-5" : "bg-chart-1/10 text-chart-1"
            )}>
              {streamLoading ? "syncing" : streamError ? "stream error" : "live"}
            </span>
            <div className="flex-1" />
            <input
              placeholder="Filter..."
              value={textFilter}
              onChange={(e) => setTextFilter(e.target.value)}
              className="bg-background border border-border rounded px-2 py-0.5 text-[11px] text-foreground w-40 outline-none focus:border-primary"
            />
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              className="bg-background border border-border rounded px-1.5 py-0.5 text-[11px] text-foreground outline-none"
            >
              <option value="all">All levels</option>
              <option value="error">Error</option>
              <option value="warn">Warn</option>
              <option value="info">Info</option>
            </select>
          </div>

          <div ref={logRef} onScroll={handleLogScroll} className="flex-1 overflow-auto px-3 py-1 font-mono text-[11px] leading-4">
            {streamError ? (
              <div className="p-5 text-center text-xs text-chart-5">{streamError}</div>
            ) : filtered.length === 0 ? (
              <div className="text-muted-foreground/30 p-5 text-center">{streamLoading ? "Connecting to live stream..." : "No events matching filter"}</div>
            ) : (
              filtered.map((e, i) => (
                <div key={getEventKey(e, i)} className={cn(
                  "flex gap-2 py-px",
                  e.level === "error" ? "text-chart-5" : e.level === "warn" ? "text-chart-4" : "text-muted-foreground"
                )}>
                  <span className="text-muted-foreground/30 min-w-[55px] shrink-0">{e.ts.slice(11, 19)}</span>
                  <span className="text-muted-foreground/50 min-w-[90px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap">{e.cat}</span>
                  {e.workflow_ref && (
                    <span onClick={() => setStreamFilter({ type: "workflow", value: e.workflow_ref! })}
                      className="text-accent shrink-0 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap max-w-[100px]">{e.workflow_ref}</span>
                  )}
                  {e.phase_id && <span className="text-primary shrink-0 text-[10px]">{e.phase_id}</span>}
                  {e.model && <span className="text-muted-foreground/40 shrink-0 text-[10px]">{e.model.replace("kimi-code/", "")}</span>}
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{e.msg}</span>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

const PRIORITY_COLORS: Record<string, string> = { critical: "#ef4444", high: "#f97316", medium: "#eab308", low: "#6b7280" };
const TASK_STATUS_COLORS: Record<string, string> = {
  done: "#22c55e", ready: "#3b82f6", "in-progress": "#a78bfa", in_progress: "#a78bfa",
  blocked: "#eab308", backlog: "#6b7280", cancelled: "#ef4444", "on-hold": "#f97316", on_hold: "#f97316",
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
          className={cn("text-[10px] px-2 py-0.5 rounded cursor-pointer border", statusFilter === "all" ? "bg-primary/15 border-primary/40 text-foreground" : "bg-card border-border text-muted-foreground")}>
          All ({tasks.length})
        </span>
        {[...statuses].sort((a, b) => b[1] - a[1]).map(([status, count]) => (
          <span key={status} onClick={() => setStatusFilter(statusFilter === status ? "all" : status)}
            className={cn("text-[10px] px-2 py-0.5 rounded cursor-pointer border", statusFilter === status ? "bg-primary/15" : "bg-card")}
            style={{ color: TASK_STATUS_COLORS[status] || "#888", borderColor: statusFilter === status ? (TASK_STATUS_COLORS[status] || "#333") : "hsl(225 20% 15%)" }}>
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
              style={{ background: `${TASK_STATUS_COLORS[t.status] || "#333"}20`, color: TASK_STATUS_COLORS[t.status] || "#888" }}>{t.status}</span>
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
            <span className="text-chart-4 min-w-[60px] shrink-0">{c.hash}</span>
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
            <div key={wf.id} className="mb-2.5 p-2 bg-background rounded border-l-[3px] border-accent">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="font-semibold text-xs text-accent">{wf.id}</span>
                {wf.name && <span className="text-[10px] text-muted-foreground">— {wf.name}</span>}
              </div>
              {wf.description && <div className="text-[10px] text-muted-foreground/50 mb-1">{wf.description}</div>}
              <div className="flex gap-1 flex-wrap">
                {wf.phases.map((pid, i) => {
                  const phase = config.phases.find((p) => p.id === pid);
                  return (
                    <span key={i} onClick={() => setExpandedPhase(expandedPhase === pid ? null : pid)}
                      className={cn("text-[9px] px-1.5 py-0.5 rounded cursor-pointer border",
                        phase?.mode === "command" ? "bg-chart-1/10 text-chart-1 border-chart-1/20" : "bg-primary/10 text-primary border-primary/20"
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
            <div key={s.id} className={cn("p-1.5 px-2 mb-1 bg-background rounded border-l-[3px]", s.enabled ? "border-chart-4" : "border-muted-foreground/20")}>
              <div className="flex justify-between items-center">
                <span className="text-chart-4 font-semibold text-[11px]">{s.id}</span>
                {!s.enabled && <span className="text-[8px] text-chart-5 bg-chart-5/10 px-1 py-px rounded">disabled</span>}
              </div>
              <div className="flex justify-between mt-0.5">
                <span className="text-[10px] text-muted-foreground">{cronToHuman(s.cron)}</span>
                <span className="text-[9px] text-muted-foreground/40 font-mono">{s.cron}</span>
              </div>
              <div className="text-[9px] text-accent mt-px">→ {s.workflow_ref}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="bg-card rounded-lg p-3 border border-border">
          <h3 className="text-[11px] text-muted-foreground/50 uppercase tracking-wide mb-2 font-semibold">Agents ({config.agents.length})</h3>
          {config.agents.map((a) => (
            <div key={a.name} onClick={() => setExpandedAgent(expandedAgent === a.name ? null : a.name)}
              className={cn("p-2 mb-1 bg-background rounded cursor-pointer border-l-[3px]", expandedAgent === a.name ? "border-primary" : "border-transparent")}>
              <div className="flex justify-between items-center">
                <span className="text-primary font-semibold text-[11px]">{a.name}</span>
                <div className="flex gap-1 items-center">
                  <span className="text-[9px] text-muted-foreground">{a.model.replace("kimi-code/", "")}</span>
                  <span className="text-[9px] text-muted-foreground/40 bg-secondary px-1 py-px rounded">{a.tool}</span>
                </div>
              </div>
              {a.mcp_servers.length > 0 && (
                <div className="flex gap-1 mt-1">
                  {a.mcp_servers.map((s) => (
                    <span key={s} className="text-[8px] px-1 py-px rounded bg-chart-1/10 text-chart-1">{s}</span>
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
              className={cn("p-1.5 mb-0.5 bg-background rounded cursor-pointer border-l-[3px]",
                expandedPhase === ph.id ? (ph.mode === "command" ? "border-chart-1" : "border-primary") : "border-transparent"
              )}>
              <div className="flex justify-between items-center">
                <span className={cn("font-semibold text-[10px]", ph.mode === "command" ? "text-chart-1" : "text-primary")}>{ph.id}</span>
                <span className="text-[9px] text-muted-foreground/30">
                  {ph.mode === "command" ? (ph.command ? `$ ${ph.command} ${ph.command_args.join(" ")}` : "cmd") : (ph.agent || "agent")}
                </span>
              </div>
              {expandedPhase === ph.id && (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {ph.mode === "command" && ph.command && (
                    <div className="font-mono bg-card p-1.5 rounded mb-1">
                      <span className="text-chart-1">$ {ph.command} {ph.command_args.join(" ")}</span>
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

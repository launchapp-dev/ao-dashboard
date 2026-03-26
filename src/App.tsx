import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FleetOverview } from "./FleetOverview";
import { FleetFlow } from "./FleetFlow";
import { EventStream } from "./EventStream";
import { CommandCenter } from "./CommandCenter";
import { TaskWorkbench } from "./TaskWorkbench";
import type {
  DaemonHealth,
  StreamEvent,
  Project,
  FleetProject,
  WorkflowInfo,
  TaskSummary,
  GlobalAoInfo,
} from "./types";
import { loadCachedFleet, saveCachedFleet } from "./store";
import { cn } from "@/lib/utils";

const MAX_EVENTS = 5000;
const MAX_CACHED_EVENTS = 3000;
const EVENT_FLUSH_MS = 100;

type AppTab = "overview" | "flow" | "stream" | "tasks" | "cli";

const TAB_META: Array<{
  id: AppTab;
  label: string;
  compactLabel: string;
  railLabel: string;
  eyebrow: string;
  description: string;
  shortDescription: string;
}> = [
  {
    id: "overview",
    label: "Fleet Overview",
    compactLabel: "OV",
    railLabel: "Overview",
    eyebrow: "Mission Control",
    description: "Track daemon health, AO home status, and project-level operating pressure from a single surface.",
    shortDescription: "Health, AO home, and project pulse.",
  },
  {
    id: "flow",
    label: "System Flow",
    compactLabel: "FL",
    railLabel: "Flow",
    eyebrow: "Topology Map",
    description: "Inspect the live workflow graph across projects, schedules, phases, agents, and MCP dependencies.",
    shortDescription: "Project topology and execution paths.",
  },
  {
    id: "stream",
    label: "Event Stream",
    compactLabel: "EV",
    railLabel: "Events",
    eyebrow: "Live Feed",
    description: "Watch the aggregated event firehose with fast filtering for project, category, and severity.",
    shortDescription: "Cross-project event firehose.",
  },
  {
    id: "tasks",
    label: "Task Workbench",
    compactLabel: "TK",
    railLabel: "Tasks",
    eyebrow: "Operational Backlog",
    description: "Move from fleet telemetry into concrete work: inspect, prioritize, assign, and update AO tasks.",
    shortDescription: "Task list, detail, and actions.",
  },
  {
    id: "cli",
    label: "Command Center",
    compactLabel: "AO",
    railLabel: "AO CLI",
    eyebrow: "AO Surface",
    description: "Navigate the installed AO CLI, run commands in project or global scope, and stream structured output.",
    shortDescription: "Browse and run AO commands.",
  },
];

function App() {
  const [health, setHealth] = useState<DaemonHealth[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workflows, setWorkflows] = useState<Record<string, WorkflowInfo[]>>({});
  const [tasks, setTasks] = useState<Record<string, TaskSummary>>({});
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [globalAoInfo, setGlobalAoInfo] = useState<GlobalAoInfo | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>("overview");
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const projectsRef = useRef<Project[]>([]);
  const pendingEventsRef = useRef<StreamEvent[]>([]);
  const eventFlushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    loadCachedFleet().then((cached) => {
      if (cached) {
        setWorkflows(cached.workflows);
        setTasks(cached.tasks);
        setEvents(cached.events.slice(-MAX_EVENTS));
      }
    });
  }, []);

  const flushPendingEvents = useCallback(() => {
    eventFlushTimerRef.current = null;
    if (pendingEventsRef.current.length === 0) return;
    const batch = pendingEventsRef.current.splice(0, pendingEventsRef.current.length);
    startTransition(() => {
      setEvents((prev) => {
        const next = prev.concat(batch);
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });
    });
  }, []);

  const refreshGlobalAoInfo = useCallback(async () => {
    try {
      const info = await invoke<GlobalAoInfo>("get_global_ao_info");
      setGlobalAoInfo(info);
    } catch (error) {
      console.error("global ao info error:", error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    invoke<Project[]>("discover_projects")
      .then((p) => {
        if (cancelled) return;
        setProjects(p);
        projectsRef.current = p;
        setLoading(false);
        p.forEach((proj) => {
          invoke("start_stream", { projectRoot: proj.root }).catch(console.error);
        });
      })
      .catch((error) => {
        console.error("discover projects error:", error);
        if (!cancelled) setLoading(false);
      });

    const unlisten = listen<StreamEvent>("stream-event", (e) => {
      pendingEventsRef.current.push(e.payload);
      if (pendingEventsRef.current.length > MAX_EVENTS * 2) {
        pendingEventsRef.current.splice(0, pendingEventsRef.current.length - MAX_EVENTS);
      }
      if (eventFlushTimerRef.current === null) {
        eventFlushTimerRef.current = window.setTimeout(flushPendingEvents, EVENT_FLUSH_MS);
      }
    });

    return () => {
      cancelled = true;
      if (eventFlushTimerRef.current !== null) {
        window.clearTimeout(eventFlushTimerRef.current);
        eventFlushTimerRef.current = null;
      }
      pendingEventsRef.current = [];
      unlisten.then((fn) => fn());
    };
  }, [flushPendingEvents]);

  useEffect(() => {
    refreshGlobalAoInfo();
    const interval = setInterval(refreshGlobalAoInfo, 60000);
    return () => clearInterval(interval);
  }, [refreshGlobalAoInfo]);

  const healthFetchingRef = useRef(false);
  const refreshHealth = useCallback(async () => {
    if (healthFetchingRef.current || projectsRef.current.length === 0) return;
    healthFetchingRef.current = true;
    try {
      const h = await invoke<DaemonHealth[]>("get_all_health", { projects: projectsRef.current });
      if (h.length > 0) setHealth(h);
    } catch (e) {
      console.error("health error:", e);
    } finally {
      healthFetchingRef.current = false;
    }
  }, []);

  const detailFetchingRef = useRef(false);
  const refreshDetails = useCallback(async () => {
    const currentProjects = projectsRef.current;
    if (detailFetchingRef.current || currentProjects.length === 0) return;
    detailFetchingRef.current = true;

    try {
      const detailResults = await Promise.all(
        currentProjects.map(async (proj) => {
          const [workflowResult, taskResult] = await Promise.allSettled([
            invoke<WorkflowInfo[]>("get_workflows", { projectRoot: proj.root }),
            invoke<TaskSummary>("get_task_summary", { projectRoot: proj.root }),
          ]);

          return {
            root: proj.root,
            workflows: workflowResult.status === "fulfilled" ? workflowResult.value : null,
            taskSummary: taskResult.status === "fulfilled" ? taskResult.value : null,
          };
        }),
      );

      setWorkflows((prev) => {
        const next = { ...prev };
        for (const result of detailResults) {
          if (result.workflows) next[result.root] = result.workflows;
        }
        return next;
      });

      setTasks((prev) => {
        const next = { ...prev };
        for (const result of detailResults) {
          if (result.taskSummary) next[result.root] = result.taskSummary;
        }
        return next;
      });
    } finally {
      detailFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (projects.length > 0) {
      refreshHealth();
      refreshDetails();
      const healthInterval = setInterval(refreshHealth, 30000);
      const detailInterval = setInterval(refreshDetails, 30000);
      return () => {
        clearInterval(healthInterval);
        clearInterval(detailInterval);
      };
    }
  }, [projects, refreshHealth, refreshDetails]);

  useEffect(() => {
    if (health.length > 0 || Object.keys(workflows).length > 0) {
      saveCachedFleet({
        health,
        workflows,
        tasks,
        events: events.slice(-MAX_CACHED_EVENTS),
        updatedAt: Date.now(),
      });
    }
  }, [events, health, workflows, tasks]);

  const healthByRoot = useMemo(
    () => new Map(health.map((entry) => [entry.root, entry])),
    [health],
  );

  const fleet: FleetProject[] = projects.map((p) => ({
    name: p.name,
    root: p.root,
    health: healthByRoot.get(p.root) || null,
    workflows: workflows[p.root] || [],
    tasks: tasks[p.root] || null,
  }));

  const totalAgents = health.reduce((sum, item) => sum + item.active_agents, 0);
  const totalPool = health.reduce((sum, item) => sum + item.pool_size, 0);
  const totalQueue = health.reduce((sum, item) => sum + item.queued_tasks, 0);
  const totalTasks = Object.values(tasks).reduce((sum, item) => sum + item.total, 0);
  const totalWorkflows = Object.values(workflows).reduce((sum, item) => sum + item.length, 0);
  const runningProjects = health.filter((item) => item.status === "running").length;
  const errors = events.filter((event) => event.level === "error").length;
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const activeMeta = TAB_META.find((tab) => tab.id === activeTab) ?? TAB_META[0];
  const fleetStatusTone = errors > 0 ? "critical" : totalQueue > 20 ? "warning" : "success";
  const fleetStatusLabel = errors > 0 ? "Attention needed" : totalQueue > 20 ? "Queue pressure" : "Stable";
  const syncLabel = globalAoInfo?.sync.configured
    ? shortValue(globalAoInfo.sync.server ?? globalAoInfo.sync.project_id ?? "Connected")
    : "Local only";
  const primarySignal = errors > 0
    ? `${formatCount(errors)} active errors are surfacing across the fleet.`
    : totalQueue > 20
      ? `${formatCount(totalQueue)} queued subjects are building up across running projects.`
      : `${formatCount(runningProjects)} projects are online and operating within expected pressure.`;

  const tabMetrics: Record<AppTab, string> = {
    overview: formatCount(projects.length),
    flow: formatCount(runningProjects),
    stream: formatCount(events.length),
    tasks: formatCount(totalTasks),
    cli: formatCount(projects.length),
  };

  const renderActiveView = () => {
    if (loading) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          Discovering projects and restoring the latest fleet state…
        </div>
      );
    }

    if (activeTab === "overview") {
      return <FleetOverview projects={fleet} events={events} globalAoInfo={globalAoInfo} />;
    }
    if (activeTab === "flow") {
      return <FleetFlow health={health} events={events} projects={projects} />;
    }
    if (activeTab === "stream") {
      return <EventStream events={events} />;
    }
    if (activeTab === "tasks") {
      return <TaskWorkbench projects={projects} />;
    }
    return <CommandCenter projects={projects} />;
  };

  return (
    <div className="relative h-screen overflow-hidden bg-background text-foreground font-sans">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsla(178,70%,58%,0.18),transparent_34%),radial-gradient(circle_at_top_right,hsla(34,84%,60%,0.18),transparent_30%),linear-gradient(180deg,transparent,hsla(220,20%,6%,0.58)_68%,hsla(220,22%,5%,0.9))]" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      </div>

      <div
        className={cn(
          "relative grid h-full w-full",
          navCollapsed ? "lg:grid-cols-[84px_minmax(0,1fr)]" : "lg:grid-cols-[320px_minmax(0,1fr)]",
        )}
      >
        <aside className="flex h-full min-h-0 flex-col border-r border-white/10 bg-[linear-gradient(180deg,hsla(218,24%,13%,0.995),hsla(220,22%,8%,1))] shadow-[18px_0_40px_rgba(0,0,0,0.18)]">
          <div className="flex h-full flex-col">
            <div className={cn("border-b border-white/10 px-3 py-4", navCollapsed ? "lg:px-2.5" : "lg:px-4")}>
              <div className={cn("flex items-start gap-3", navCollapsed && "lg:flex-col lg:items-center lg:gap-2")}>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-primary/20 bg-primary/10 text-[11px] font-semibold tracking-[0.24em] text-primary">
                  AO
                </div>
                {!navCollapsed && (
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">AO Fleet Console</div>
                    <div className="mt-1 text-base font-semibold text-foreground">Operations</div>
                    <div className="mt-2 space-y-1 text-[12px] leading-4 text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <span className={cn("h-2 w-2 rounded-full", statusToneDotClass(fleetStatusTone))} />
                        <span>{fleetStatusLabel}</span>
                      </div>
                      <div>{formatCount(projects.length)} projects, {formatCount(totalAgents)} active agents</div>
                      <div>30 second refresh cadence</div>
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setNavCollapsed((current) => !current)}
                  className={cn(
                    "border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground",
                    navCollapsed ? "" : "ml-auto",
                  )}
                  aria-label={navCollapsed ? "Expand navigation sidebar" : "Collapse navigation sidebar"}
                >
                  {navCollapsed ? "»" : "Hide"}
                </button>
              </div>
            </div>

            <div className={cn("grid gap-3 px-3 py-4 lg:flex-1 lg:overflow-auto", navCollapsed ? "lg:px-2 lg:py-3" : "lg:px-4")}>
              {!navCollapsed && (
                <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
                  <span>Control Surfaces</span>
                  <span>{TAB_META.length}</span>
                </div>
              )}
              {TAB_META.map((tab) => (
                <SidebarNavItem
                  key={tab.id}
                  active={activeTab === tab.id}
                  collapsed={navCollapsed}
                  label={tab.railLabel}
                  code={tab.compactLabel}
                  eyebrow={tab.eyebrow}
                  description={tab.shortDescription}
                  metric={tabMetrics[tab.id]}
                  onClick={() => setActiveTab(tab.id)}
                />
              ))}
            </div>

            {!navCollapsed ? (
              <div className="grid gap-3 border-t border-white/10 px-4 py-4">
                <div className="text-[10px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
                  Context
                </div>
                <RailContextList
                  title="AO Home"
                  items={[
                    globalAoInfo ? compactPath(globalAoInfo.ao_home) : "Resolving AO home",
                    globalAoInfo?.agent_runner_token_configured ? "Runner token configured" : "Runner token missing",
                    globalAoInfo?.sync.configured ? "Global sync configured" : "Local workspace mode",
                  ]}
                />
                <RailContextList
                  title="Activity"
                  items={[
                    `${formatCount(totalWorkflows)} workflows visible`,
                    `${formatCount(errors)} buffered errors`,
                    lastEvent ? `Latest event ${lastEvent.ts.slice(11, 19)}` : "Waiting for event traffic",
                  ]}
                />
              </div>
            ) : (
              <div className="grid gap-2 border-t border-white/10 px-2 py-3">
                <CollapsedRailStat label="WF" value={formatCount(totalWorkflows)} />
                <CollapsedRailStat label="ERR" value={formatCount(errors)} tone={errors > 0 ? "critical" : "default"} />
                <CollapsedRailStat label="AO" value={globalAoInfo?.sync.configured ? "ON" : "OFF"} tone={globalAoInfo?.sync.configured ? "success" : "default"} />
              </div>
            )}
          </div>
        </aside>

        <section className="min-h-0 min-w-0 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col gap-2 px-2 py-2 sm:px-3 sm:py-3 lg:gap-3 lg:px-4 lg:py-4">
            <header className="overflow-hidden rounded-[16px] border border-white/10 bg-[linear-gradient(135deg,hsla(215,27%,16%,0.9),hsla(220,24%,10%,0.88))] shadow-[0_14px_32px_rgba(0,0,0,0.18)] backdrop-blur-xl">
              <div className="flex flex-col gap-2 px-3 py-2.5 sm:px-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
                    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2 py-0.5">AO Fleet</span>
                    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-2.5 py-0.5 normal-case tracking-normal text-[11px]">
                      <span className={cn("h-2 w-2 rounded-full", statusToneDotClass(fleetStatusTone))} />
                      <span className="font-medium text-foreground">{fleetStatusLabel}</span>
                    </span>
                  </div>
                  <div className="mt-1.5 text-sm font-semibold text-foreground">
                    Fleet operations cockpit
                  </div>
                  <div className="mt-0.5 text-[12px] text-muted-foreground">
                    {primarySignal}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 text-[11px]">
                  <CompactHeaderMetric label="Live" value={`${formatCount(runningProjects)}/${formatCount(projects.length)}`} tone={fleetStatusTone} />
                  <CompactHeaderMetric label="Agents" value={`${formatCount(totalAgents)}/${formatCount(totalPool)}`} />
                  <CompactHeaderMetric label="Queue" value={formatCount(totalQueue)} tone={totalQueue > 20 ? "warning" : "default"} />
                  <CompactHeaderMetric label="Sync" value={syncLabel} tone={globalAoInfo?.sync.configured ? "success" : "default"} />
                </div>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-hidden rounded-[18px] border border-white/10 bg-[linear-gradient(180deg,hsla(217,26%,13%,0.98),hsla(222,24%,9%,0.98))] shadow-[0_24px_70px_rgba(0,0,0,0.22)]">
              <div className="flex h-full min-h-0 flex-col">
                <div className="border-b border-white/10 px-4 py-2.5 sm:px-5">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
                    <div className="max-w-3xl">
                      <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
                        {activeMeta.eyebrow}
                      </p>
                      <h2 className="mt-1 text-lg font-semibold tracking-[-0.03em] text-foreground">
                        {activeMeta.label}
                      </h2>
                      <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">
                        {activeMeta.shortDescription}
                      </p>
                    </div>

                    <div className="grid gap-1 text-right text-[11px] text-muted-foreground">
                      <div>{syncLabel} sync context</div>
                      <div>{formatCount(totalWorkflows)} workflows visible</div>
                    </div>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-hidden bg-[linear-gradient(180deg,hsla(0,0%,100%,0.02),transparent_20%)]">
                  {renderActiveView()}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function CompactHeaderMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "critical";
}) {
  return (
    <div className="rounded-full border border-white/10 bg-black/18 px-3 py-1.5">
      <div className={cn("text-sm font-semibold", toneTextClass(tone))}>{value}</div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
    </div>
  );
}

function SidebarNavItem({
  active,
  collapsed,
  label,
  code,
  eyebrow,
  description,
  metric,
  onClick,
}: {
  active: boolean;
  collapsed: boolean;
  label: string;
  code: string;
  eyebrow: string;
  description: string;
  metric: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative overflow-hidden border-l-2 px-3 py-3 text-left transition-all duration-200",
        active
          ? "border-l-primary bg-white/[0.05]"
          : "border-l-transparent bg-transparent hover:border-l-white/20 hover:bg-white/[0.03]",
        collapsed && "lg:px-2 lg:py-3",
      )}
    >
      <div className={cn("flex items-start gap-3", collapsed && "lg:flex-col lg:items-center lg:gap-2")}>
        <div
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center border text-[11px] font-semibold tracking-[0.18em] transition-colors",
            collapsed && "lg:mt-0",
            active
              ? "border-primary/25 bg-primary/10 text-primary"
              : "border-white/10 bg-black/10 text-muted-foreground",
          )}
        >
          {code}
        </div>
        <div className={cn("min-w-0 flex-1", collapsed && "lg:w-full lg:text-center")}>
          <div className={cn("flex items-start justify-between gap-3", collapsed && "lg:flex-col lg:items-center lg:gap-1")}>
            <span className="text-[13px] font-semibold text-foreground">
              {collapsed ? code : label}
            </span>
            <span
              className={cn(
                "border px-2 py-0.5 text-[10px] font-medium",
                active
                  ? "border-primary/20 bg-primary/8 text-foreground"
                  : "border-white/10 bg-black/10 text-muted-foreground",
              )}
            >
              {metric}
            </span>
          </div>
          {!collapsed && (
            <>
              <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                {eyebrow}
              </div>
              <p className="mt-1.5 max-w-[22rem] text-[12px] leading-4 text-muted-foreground">{description}</p>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

function RailContextList({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  return (
    <div className="border-t border-white/8 pt-2">
      <div className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">{title}</div>
      <div className="mt-2 space-y-1.5">
        {items.map((line) => (
          <div key={line} className="text-[12px] leading-4 text-foreground/88">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function CollapsedRailStat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "critical";
}) {
  return (
    <div className="border border-white/8 bg-black/12 px-2 py-2 text-center">
      <div className="text-[9px] font-medium uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-[11px] font-semibold", toneTextClass(tone))}>{value}</div>
    </div>
  );
}

function toneTextClass(tone: "default" | "success" | "warning" | "critical") {
  if (tone === "success") return "text-chart-1";
  if (tone === "warning") return "text-chart-4";
  if (tone === "critical") return "text-chart-5";
  return "text-foreground";
}

function statusToneDotClass(tone: "default" | "success" | "warning" | "critical") {
  if (tone === "success") return "bg-chart-1";
  if (tone === "warning") return "bg-chart-4";
  if (tone === "critical") return "bg-chart-5";
  return "bg-muted-foreground";
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function shortValue(value: string) {
  if (value.length <= 18) return value;
  return `${value.slice(0, 15)}…`;
}

function compactPath(value: string) {
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 3) return value;
  return `/${parts.slice(-3).join("/")}`;
}

export default App;

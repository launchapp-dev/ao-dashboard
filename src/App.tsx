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
  FleetData,
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
}> = [
  {
    id: "overview",
    label: "Fleet Overview",
    compactLabel: "OV",
    railLabel: "Overview",
    eyebrow: "Mission Control",
    description: "Track daemon health and project-level operating pressure.",
  },
  {
    id: "flow",
    label: "System Flow",
    compactLabel: "FL",
    railLabel: "Flow",
    eyebrow: "Topology Map",
    description: "Inspect the live workflow graph across projects and agents.",
  },
  {
    id: "stream",
    label: "Event Stream",
    compactLabel: "EV",
    railLabel: "Events",
    eyebrow: "Live Feed",
    description: "Watch the aggregated event firehose with fast filtering.",
  },
  {
    id: "tasks",
    label: "Task Workbench",
    compactLabel: "TK",
    railLabel: "Tasks",
    eyebrow: "Operational Backlog",
    description: "Inspect, prioritize, assign, and update AO tasks.",
  },
  {
    id: "cli",
    label: "Command Center",
    compactLabel: "AO",
    railLabel: "AO CLI",
    eyebrow: "AO Surface",
    description: "Navigate and run AO commands in project or global scope.",
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
        setHealth(cached.health);
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

  const fleetFetchingRef = useRef(false);
  const refreshFleet = useCallback(async () => {
    if (fleetFetchingRef.current || projectsRef.current.length === 0) return;
    fleetFetchingRef.current = true;

    try {
      const fleetData = await invoke<FleetData>("get_fleet_data");
      const nextHealth: DaemonHealth[] = [];
      const nextWorkflows: Record<string, WorkflowInfo[]> = {};
      const nextTasks: Record<string, TaskSummary> = {};

      for (const project of fleetData.projects) {
        if (project.health) nextHealth.push(project.health);
        nextWorkflows[project.root] = project.workflows ?? [];
        if (project.tasks) nextTasks[project.root] = project.tasks;
      }

      startTransition(() => {
        setHealth(nextHealth);
        setWorkflows(nextWorkflows);
        setTasks(nextTasks);
      });
    } catch (error) {
      console.error("fleet refresh error:", error);
    } finally {
      fleetFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (projects.length > 0) {
      refreshFleet();
      const fleetInterval = setInterval(refreshFleet, 30000);
      return () => {
        clearInterval(fleetInterval);
      };
    }
  }, [projects, refreshFleet]);

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
    ? `${formatCount(errors)} active errors surfacing.`
    : totalQueue > 20
      ? `${formatCount(totalQueue)} queued subjects building up.`
      : `${formatCount(runningProjects)} projects online and stable.`;

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
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsla(178,70%,58%,0.1),transparent_40%),radial-gradient(circle_at_top_right,hsla(34,84%,60%,0.08),transparent_35%)]" />
      </div>

      <div
        className={cn(
          "relative grid h-full w-full",
          navCollapsed ? "lg:grid-cols-[72px_minmax(0,1fr)]" : "lg:grid-cols-[280px_minmax(0,1fr)]",
        )}
      >
        <aside className="flex h-full min-h-0 flex-col border-r border-white/5 bg-card/40 backdrop-blur-md">
          <div className="flex h-full flex-col">
            <div className={cn("px-4 py-6", navCollapsed && "px-2 text-center")}>
              <div className={cn("flex items-center gap-3", navCollapsed && "flex-col")}>
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-xs font-bold tracking-widest text-primary shadow-[0_0_20px_rgba(var(--la-primary),0.2)]">
                  AO
                </div>
                {!navCollapsed && (
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-foreground">Fleet Console</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={cn("h-1.5 w-1.5 rounded-full shadow-[0_0_8px_currentColor]", statusToneDotClass(fleetStatusTone))} />
                      <span className="text-xs text-muted-foreground">{fleetStatusLabel}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <nav className="flex-1 space-y-1 px-2 py-4 overflow-y-auto">
              {TAB_META.map((tab) => (
                <SidebarNavItem
                  key={tab.id}
                  active={activeTab === tab.id}
                  collapsed={navCollapsed}
                  label={tab.railLabel}
                  code={tab.compactLabel}
                  metric={tabMetrics[tab.id]}
                  onClick={() => setActiveTab(tab.id)}
                />
              ))}
            </nav>

            <div className="p-4 border-t border-white/5">
              {!navCollapsed ? (
                <div className="space-y-4">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">
                    System Status
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-muted-foreground">Agents</span>
                      <span className="font-medium">{totalAgents} active</span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-muted-foreground">Sync</span>
                      <span className={cn("font-medium", globalAoInfo?.sync.configured ? "text-chart-1" : "text-muted-foreground")}>
                        {globalAoInfo?.sync.configured ? "Online" : "Local"}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <button 
                  onClick={() => setNavCollapsed(false)}
                  className="w-full flex justify-center text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span className="text-lg">»</span>
                </button>
              )}
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 flex-col bg-[linear-gradient(180deg,hsla(220,30%,7%,0.5),hsla(220,30%,5%,0.8))]">
          <header className="h-16 shrink-0 border-b border-white/5 bg-card/20 backdrop-blur-md flex items-center justify-between px-6">
            <div className="flex items-center gap-4">
              <button 
                onClick={() => setNavCollapsed(!navCollapsed)}
                className="text-muted-foreground hover:text-foreground p-1 transition-colors"
              >
                {navCollapsed ? "»" : "«"}
              </button>
              <div>
                <h1 className="text-base font-bold text-foreground">{activeMeta.label}</h1>
                <p className="text-xs text-muted-foreground">{activeMeta.description}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <CompactHeaderMetric label="Live" value={`${runningProjects}/${projects.length}`} tone={fleetStatusTone} />
              <CompactHeaderMetric label="Queue" value={formatCount(totalQueue)} tone={totalQueue > 20 ? "warning" : "default"} />
            </div>
          </header>

          <main className="flex-1 min-h-0 overflow-hidden relative">
            {renderActiveView()}
          </main>
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
    <div className="flex flex-col items-end px-3">
      <div className={cn("text-sm font-bold", toneTextClass(tone))}>{value}</div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">{label}</div>
    </div>
  );
}

function SidebarNavItem({
  active,
  collapsed,
  label,
  code,
  metric,
  onClick,
}: {
  active: boolean;
  collapsed: boolean;
  label: string;
  code: string;
  metric: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex items-center w-full h-11 transition-all duration-200 rounded-lg mx-auto",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
        collapsed ? "w-11 justify-center" : "px-3 w-[calc(100%-16px)]",
      )}
    >
      <div className={cn(
        "flex shrink-0 items-center justify-center rounded-md text-[10px] font-bold",
        active ? "text-primary" : "text-muted-foreground/60",
        collapsed ? "h-8 w-8" : "h-5 w-5"
      )}>
        {code}
      </div>
      
      {!collapsed && (
        <>
          <span className="ml-3 text-sm font-medium flex-1 text-left">{label}</span>
          <span className={cn(
            "text-[10px] font-bold px-1.5 py-0.5 rounded border",
            active ? "border-primary/30 bg-primary/5" : "border-white/5 bg-white/5"
          )}>
            {metric}
          </span>
        </>
      )}
      
      {active && (
        <div className="absolute left-0 w-1 h-5 bg-primary rounded-full -ml-px" />
      )}
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

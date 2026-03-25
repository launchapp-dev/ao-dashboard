import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FleetOverview } from "./FleetOverview";
import { FleetFlow } from "./FleetFlow";
import { EventStream } from "./EventStream";
import type { DaemonHealth, StreamEvent, Project, FleetProject, WorkflowInfo, TaskSummary } from "./types";
import { loadCachedFleet, saveCachedFleet } from "./store";
import { cn } from "@/lib/utils";

function App() {
  const [health, setHealth] = useState<DaemonHealth[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workflows, setWorkflows] = useState<Record<string, WorkflowInfo[]>>({});
  const [tasks, setTasks] = useState<Record<string, TaskSummary>>({});
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "flow" | "stream">("overview");
  const [loading, setLoading] = useState(true);
  const projectsRef = useRef<Project[]>([]);

  // Phase 0: load cached workflows/tasks for instant UI (skip health — it refreshes in <2s)
  useEffect(() => {
    loadCachedFleet().then((cached) => {
      if (cached) {
        setWorkflows(cached.workflows);
        setTasks(cached.tasks);
      }
    });
  }, []);

  // Phase 1: discover projects (instant)
  useEffect(() => {
    invoke<Project[]>("discover_projects").then((p) => {
      setProjects(p);
      projectsRef.current = p;
      setLoading(false);
      p.forEach((proj) => {
        invoke("start_stream", { projectRoot: proj.root }).catch(console.error);
      });
    });

    const unlisten = listen<StreamEvent>("stream-event", (e) => {
      setEvents((prev) => [...prev.slice(-500), e.payload]);
    });

    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Phase 2: health (fast, parallel, every 10s)
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

  // Phase 3: workflows + tasks (slower, non-blocking, every 30s)
  const refreshDetails = useCallback(async () => {
    const p = projectsRef.current;
    for (const proj of p) {
      // Fire and forget — each one updates state independently
      invoke<WorkflowInfo[]>("get_workflows", { projectRoot: proj.root })
        .then((wf) => setWorkflows((prev) => ({ ...prev, [proj.root]: wf })))
        .catch(() => {});
      invoke<TaskSummary>("get_task_summary", { projectRoot: proj.root })
        .then((ts) => setTasks((prev) => ({ ...prev, [proj.root]: ts })))
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (projects.length > 0) {
      refreshHealth();
      refreshDetails();
      const healthInterval = setInterval(refreshHealth, 30000);
      const detailInterval = setInterval(refreshDetails, 30000);
      return () => { clearInterval(healthInterval); clearInterval(detailInterval); };
    }
  }, [projects, refreshHealth, refreshDetails]);

  // Persist to cache when health or details change (not on every event)
  useEffect(() => {
    if (health.length > 0 || Object.keys(workflows).length > 0) {
      saveCachedFleet({
        health,
        workflows,
        tasks,
        events: [],
        updatedAt: Date.now(),
      });
    }
  }, [health, workflows, tasks]);

  // Build fleet by merging health + workflows + tasks
  const fleet: FleetProject[] = projects.map((p) => ({
    name: p.name,
    root: p.root,
    health: health.find((h) => h.root === p.root) || null,
    workflows: workflows[p.root] || [],
    tasks: tasks[p.root] || null,
  }));

  const totalAgents = health.reduce((s, h) => s + h.active_agents, 0);
  const totalQueue = health.reduce((s, h) => s + h.queued_tasks, 0);
  const running = health.filter((h) => h.status === "running").length;
  const errors = events.filter((e) => e.level === "error").length;

  const tabClass = (tab: string) => cn(
    "px-4 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer",
    activeTab === tab ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary"
  );

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background text-foreground font-sans">
      <header className="flex items-center gap-6 px-5 py-3 bg-card border-b border-border">
        <h1 className="text-lg font-bold text-foreground whitespace-nowrap">AO Fleet</h1>
        <div className="flex gap-5">
          <StatPill value={running} label="running" color="text-chart-1" />
          <StatPill value={totalAgents} label="agents" color="text-primary" />
          <StatPill value={totalQueue} label="queued" color={totalQueue > 20 ? "text-chart-4" : "text-muted-foreground"} />
          <StatPill value={errors} label="errors" color={errors > 0 ? "text-chart-5" : "text-muted-foreground"} />
        </div>
        <div className="flex gap-1 ml-auto">
          <button className={tabClass("overview")} onClick={() => setActiveTab("overview")}>Overview</button>
          <button className={tabClass("flow")} onClick={() => setActiveTab("flow")}>Flow</button>
          <button className={tabClass("stream")} onClick={() => setActiveTab("stream")}>Stream</button>
        </div>
      </header>
      <main className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">Discovering projects...</div>
        ) : activeTab === "overview" ? (
          <FleetOverview projects={fleet} events={events} />
        ) : activeTab === "flow" ? (
          <FleetFlow health={health} events={events} projects={projects} />
        ) : (
          <EventStream events={events} />
        )}
      </main>
    </div>
  );
}

function StatPill({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={cn("text-xl font-bold", color)}>{value}</span>
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
    </div>
  );
}

export default App;

import { type ReactNode, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import type { Project, TaskChecklistItem, TaskCreatePayload, TaskInfo, TaskRecord, TaskStats } from "./types";

const STATUS_OPTIONS = ["backlog", "todo", "ready", "in_progress", "blocked", "on_hold", "done", "cancelled"] as const;
const PRIORITY_OPTIONS = ["critical", "high", "medium", "low"] as const;
const TASK_TYPE_OPTIONS = ["feature", "bugfix", "hotfix", "refactor", "docs", "test", "chore", "experiment"] as const;
const TASKS_PAGE_SIZE = 50;
const OVERVIEW_CACHE_TTL_MS = 15_000;
const INSIGHTS_CACHE_TTL_MS = 30_000;
const DETAIL_CACHE_TTL_MS = 30_000;
const DETAIL_LOAD_DEBOUNCE_MS = 150;

const STATUS_COLORS: Record<string, string> = {
  backlog: "text-muted-foreground",
  todo: "text-accent",
  ready: "text-primary",
  in_progress: "text-chart-1",
  blocked: "text-chart-4",
  on_hold: "text-chart-3",
  done: "text-chart-1",
  cancelled: "text-chart-5",
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "text-chart-5",
  high: "text-chart-4",
  medium: "text-primary",
  low: "text-muted-foreground",
};

interface OverviewCacheEntry {
  tasks: TaskInfo[];
  hasNextPage: boolean;
  fetchedAt: number;
}

interface InsightsCacheEntry {
  stats: TaskStats | null;
  nextTask: TaskRecord | null;
  fetchedAt: number;
}

interface DetailCacheEntry {
  task: TaskRecord;
  fetchedAt: number;
}

function normalizeStatus(value: string | null | undefined) {
  return (value ?? "").replace(/-/g, "_");
}

function formatDate(value: string | null | undefined) {
  if (!value) return "None";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function toDatetimeLocal(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function toRfc3339(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function taskIdFromResult(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = record.id;
  return typeof id === "string" ? id : null;
}

function assigneeSummary(assignee: Record<string, unknown> | null | undefined) {
  if (!assignee) return "Unassigned";
  const type = typeof assignee.type === "string" ? assignee.type : "unknown";
  const value = typeof assignee.value === "string"
    ? assignee.value
    : typeof assignee.assignee === "string"
      ? assignee.assignee
      : typeof assignee.agent_role === "string"
        ? assignee.agent_role
        : null;
  if (type === "unassigned") return "Unassigned";
  return value ? `${type}: ${value}` : type;
}

function isFresh(fetchedAt: number, ttlMs: number) {
  return Date.now() - fetchedAt < ttlMs;
}

function matchesFilters(task: Pick<TaskInfo, "status" | "priority">, statusFilter: string, priorityFilter: string) {
  const normalizedStatus = normalizeStatus(task.status);
  return (statusFilter === "all" || normalizedStatus === statusFilter)
    && (priorityFilter === "all" || task.priority === priorityFilter);
}

interface Props {
  projects: Project[];
}

export function TaskWorkbench({ projects }: Props) {
  const [selectedProjectRoot, setSelectedProjectRoot] = useState(projects[0]?.root ?? "");
  const [prioritized, setPrioritized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [nextTaskLoading, setNextTaskLoading] = useState(false);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [nextTask, setNextTask] = useState<TaskRecord | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [createForm, setCreateForm] = useState<TaskCreatePayload>({
    title: "",
    description: "",
    task_type: "feature",
    priority: "medium",
  });

  const [titleDraft, setTitleDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [statusDraft, setStatusDraft] = useState<string>("backlog");
  const [priorityDraft, setPriorityDraft] = useState<string>("medium");
  const [assigneeDraft, setAssigneeDraft] = useState("");
  const [assigneeTypeDraft, setAssigneeTypeDraft] = useState<"human" | "agent">("human");
  const [deadlineDraft, setDeadlineDraft] = useState("");
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const overviewRequestRef = useRef(0);
  const insightsRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const selectedTaskIdRef = useRef<string | null>(null);
  const overviewCacheRef = useRef(new Map<string, OverviewCacheEntry>());
  const insightsCacheRef = useRef(new Map<string, InsightsCacheEntry>());
  const detailCacheRef = useRef(new Map<string, DetailCacheEntry>());
  const deferredSearch = useDeferredValue(search);

  const buildOverviewCacheKey = useCallback((projectRoot: string) => {
    return [
      projectRoot,
      prioritized ? "1" : "0",
      statusFilter,
      priorityFilter,
      deferredSearch.trim(),
      page.toString(),
    ].join("\u0000");
  }, [deferredSearch, page, prioritized, priorityFilter, statusFilter]);

  const buildDetailCacheKey = useCallback((projectRoot: string, taskId: string) => {
    return [projectRoot, taskId].join("\u0000");
  }, []);

  const invalidateProjectCaches = useCallback((projectRoot: string) => {
    const overviewPrefix = `${projectRoot}\u0000`;
    const detailPrefix = `${projectRoot}\u0000`;
    for (const key of overviewCacheRef.current.keys()) {
      if (key.startsWith(overviewPrefix)) {
        overviewCacheRef.current.delete(key);
      }
    }
    for (const key of detailCacheRef.current.keys()) {
      if (key.startsWith(detailPrefix)) {
        detailCacheRef.current.delete(key);
      }
    }
    insightsCacheRef.current.delete(projectRoot);
  }, []);

  const storeTaskDetail = useCallback((projectRoot: string, task: TaskRecord) => {
    detailCacheRef.current.set(buildDetailCacheKey(projectRoot, task.id), {
      task,
      fetchedAt: Date.now(),
    });
  }, [buildDetailCacheKey]);

  const applyTaskDetailPatch = useCallback((projectRoot: string, taskId: string, updater: (task: TaskRecord) => TaskRecord) => {
    setSelectedTask((current) => {
      if (!current || current.id !== taskId) return current;
      const next = updater(current);
      storeTaskDetail(projectRoot, next);
      return next;
    });
  }, [storeTaskDetail]);

  const applyVisibleTaskPatch = useCallback((projectRoot: string, taskId: string, updater: (task: TaskInfo) => TaskInfo | null) => {
    const overviewKey = buildOverviewCacheKey(projectRoot);
    setTasks((current) => {
      let changed = false;
      const next = current.flatMap((task) => {
        if (task.id !== taskId) return [task];
        changed = true;
        const updated = updater(task);
        return updated ? [updated] : [];
      });
      if (changed) {
        overviewCacheRef.current.set(overviewKey, {
          tasks: next,
          hasNextPage,
          fetchedAt: Date.now(),
        });
      }
      return next;
    });
  }, [buildOverviewCacheKey, hasNextPage]);

  const loadProjectInsights = useCallback(async (projectRoot: string, force = false) => {
    if (!projectRoot) return;

    const cached = insightsCacheRef.current.get(projectRoot);
    if (!force && cached && isFresh(cached.fetchedAt, INSIGHTS_CACHE_TTL_MS)) {
      setStats(cached.stats);
      setNextTask(cached.nextTask);
      setStatsLoading(false);
      setNextTaskLoading(false);
      return;
    }

    if (cached) {
      setStats(cached.stats);
      setNextTask(cached.nextTask);
    }

    const requestId = ++insightsRequestRef.current;
    if (!cached || force) {
      setStatsLoading(true);
      setNextTaskLoading(true);
    }

    const [statsResult, nextTaskResult] = await Promise.allSettled([
      invoke<TaskStats>("get_task_stats", { projectRoot }),
      invoke<TaskRecord | null>("get_next_task", { projectRoot }),
    ]);

    if (requestId !== insightsRequestRef.current) return;

    const nextStats = statsResult.status === "fulfilled"
      ? statsResult.value
      : cached?.stats ?? null;
    const nextTaskRecord = nextTaskResult.status === "fulfilled"
      ? nextTaskResult.value
      : cached?.nextTask ?? null;

    if (statsResult.status === "rejected") {
      console.error("task stats error:", statsResult.reason);
    }
    if (nextTaskResult.status === "rejected") {
      console.error("next task error:", nextTaskResult.reason);
    }

    setStats(nextStats);
    setNextTask(nextTaskRecord);
    insightsCacheRef.current.set(projectRoot, {
      stats: nextStats,
      nextTask: nextTaskRecord,
      fetchedAt: Date.now(),
    });
    setStatsLoading(false);
    setNextTaskLoading(false);
  }, []);

  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);

  useEffect(() => {
    if (!projects.some((project) => project.root === selectedProjectRoot)) {
      setSelectedProjectRoot(projects[0]?.root ?? "");
    }
  }, [projects, selectedProjectRoot]);

  useEffect(() => {
    setPage(0);
  }, [selectedProjectRoot, prioritized, statusFilter, priorityFilter, deferredSearch]);

  const loadTaskDetail = useCallback(async (projectRoot: string, taskId: string | null, force = false) => {
    if (!projectRoot || !taskId) {
      setSelectedTask(null);
      setDetailLoading(false);
      return;
    }

    const cached = detailCacheRef.current.get(buildDetailCacheKey(projectRoot, taskId));
    if (!force && cached && isFresh(cached.fetchedAt, DETAIL_CACHE_TTL_MS)) {
      setSelectedTask(cached.task);
      setDetailLoading(false);
      return;
    }

    const requestId = ++detailRequestRef.current;
    if (cached) {
      setSelectedTask(cached.task);
    }
    if (!cached || force) {
      setDetailLoading(true);
    }
    try {
      const task = await invoke<TaskRecord>("get_task_detail", { projectRoot, id: taskId });
      if (requestId !== detailRequestRef.current) return;
      storeTaskDetail(projectRoot, task);
      setSelectedTask(task);
    } catch (error) {
      if (requestId !== detailRequestRef.current) return;
      console.error("task detail error:", error);
      if (!cached) {
        setSelectedTask(null);
      }
      setFeedback(String(error));
    } finally {
      if (requestId !== detailRequestRef.current) return;
      setDetailLoading(false);
    }
  }, [buildDetailCacheKey, storeTaskDetail]);

  const loadOverview = useCallback(async (
    projectRoot: string,
    options?: {
      force?: boolean;
      preferredTaskId?: string | null;
    },
  ) => {
    if (!projectRoot) return;

    const force = options?.force ?? false;
    const preferredTaskId = options?.preferredTaskId ?? null;
    const overviewKey = buildOverviewCacheKey(projectRoot);
    const cached = overviewCacheRef.current.get(overviewKey);

    if (!force && cached && isFresh(cached.fetchedAt, OVERVIEW_CACHE_TTL_MS)) {
      setTasks(cached.tasks);
      setHasNextPage(cached.hasNextPage);
      const nextSelectedId = preferredTaskId && cached.tasks.some((task) => task.id === preferredTaskId)
        ? preferredTaskId
        : selectedTaskIdRef.current && cached.tasks.some((task) => task.id === selectedTaskIdRef.current)
          ? selectedTaskIdRef.current
          : null;
      setSelectedTaskId(nextSelectedId);
      setLoading(false);
      return;
    }

    const requestId = ++overviewRequestRef.current;
    if (cached) {
      setTasks(cached.tasks);
      setHasNextPage(cached.hasNextPage);
    }
    setLoading(true);
    setFeedback(null);

    try {
      const taskList = await invoke<TaskInfo[]>("get_task_list", {
        projectRoot,
        prioritized,
        status: statusFilter === "all" ? null : statusFilter,
        priority: priorityFilter === "all" ? null : priorityFilter,
        search: deferredSearch.trim() ? deferredSearch.trim() : null,
        limit: TASKS_PAGE_SIZE + 1,
        offset: page * TASKS_PAGE_SIZE,
      });
      if (requestId !== overviewRequestRef.current) return;
      setHasNextPage(taskList.length > TASKS_PAGE_SIZE);
      const visibleTasks = taskList.slice(0, TASKS_PAGE_SIZE);
      overviewCacheRef.current.set(overviewKey, {
        tasks: visibleTasks,
        hasNextPage: taskList.length > TASKS_PAGE_SIZE,
        fetchedAt: Date.now(),
      });
      setTasks(visibleTasks);

      const nextSelectedId = preferredTaskId && visibleTasks.some((task) => task.id === preferredTaskId)
        ? preferredTaskId
        : selectedTaskIdRef.current && visibleTasks.some((task) => task.id === selectedTaskIdRef.current)
          ? selectedTaskIdRef.current
          : null;

      setSelectedTaskId(nextSelectedId);
    } catch (error) {
      if (requestId !== overviewRequestRef.current) return;
      console.error("task overview error:", error);
      setTasks([]);
      setHasNextPage(false);
      setSelectedTaskId(null);
      setSelectedTask(null);
      setFeedback(String(error));
    } finally {
      if (requestId !== overviewRequestRef.current) return;
      setLoading(false);
    }
  }, [buildOverviewCacheKey, deferredSearch, page, prioritized, priorityFilter, statusFilter]);

  useEffect(() => {
    if (selectedProjectRoot) {
      loadOverview(selectedProjectRoot);
    }
  }, [selectedProjectRoot, loadOverview]);

  useEffect(() => {
    if (!selectedProjectRoot) {
      setStats(null);
      setNextTask(null);
      setStatsLoading(false);
      setNextTaskLoading(false);
      return;
    }

    const timer = window.setTimeout(() => {
      void loadProjectInsights(selectedProjectRoot);
    }, 80);

    return () => window.clearTimeout(timer);
  }, [selectedProjectRoot, loadProjectInsights]);

  useEffect(() => {
    if (selectedProjectRoot && selectedTaskId) {
      const timer = window.setTimeout(() => {
        void loadTaskDetail(selectedProjectRoot, selectedTaskId);
      }, DETAIL_LOAD_DEBOUNCE_MS);

      return () => window.clearTimeout(timer);
    } else {
      setSelectedTask(null);
      setDetailLoading(false);
    }
  }, [selectedProjectRoot, selectedTaskId, loadTaskDetail]);

  useEffect(() => {
    if (!selectedTask) return;
    setTitleDraft(selectedTask.title ?? "");
    setDescriptionDraft(selectedTask.description ?? "");
    setStatusDraft(normalizeStatus(selectedTask.status) || "backlog");
    setPriorityDraft(selectedTask.priority ?? "medium");
    setAssigneeDraft(
      typeof selectedTask.assignee?.value === "string"
        ? selectedTask.assignee.value
        : typeof selectedTask.assignee?.agent_role === "string"
          ? selectedTask.assignee.agent_role
          : "",
    );
    setAssigneeTypeDraft(selectedTask.assignee?.type === "agent" ? "agent" : "human");
    setDeadlineDraft(toDatetimeLocal(selectedTask.deadline));
    setNewChecklistItem("");
  }, [selectedTask]);

  const withAction = useCallback(async (label: string, operation: () => Promise<void>) => {
    setBusyAction(label);
    setFeedback(null);
    try {
      await operation();
    } catch (error) {
      console.error(`${label} failed:`, error);
      setFeedback(String(error));
    } finally {
      setBusyAction(null);
    }
  }, []);

  const refreshCurrentView = useCallback(async (forceDetail = false) => {
    if (!selectedProjectRoot) return;
    invalidateProjectCaches(selectedProjectRoot);
    await loadOverview(selectedProjectRoot, { force: true, preferredTaskId: selectedTaskId });
    void loadProjectInsights(selectedProjectRoot, true);
    if (forceDetail && selectedTaskId) {
      await loadTaskDetail(selectedProjectRoot, selectedTaskId, true);
    }
  }, [invalidateProjectCaches, loadOverview, loadProjectInsights, loadTaskDetail, selectedProjectRoot, selectedTaskId]);

  const handleCreateTask = async () => {
    if (!selectedProjectRoot || !createForm.title?.trim()) return;
    await withAction("create-task", async () => {
      const result = await invoke<unknown>("create_task", {
        projectRoot: selectedProjectRoot,
        payload: createForm,
      });
      const createdId = taskIdFromResult(result);
      setCreateForm({ title: "", description: "", task_type: "feature", priority: "medium" });
      setShowCreateForm(false);
      invalidateProjectCaches(selectedProjectRoot);
      if (page !== 0) {
        setPage(0);
      } else {
        await loadOverview(selectedProjectRoot, { force: true, preferredTaskId: createdId });
      }
      void loadProjectInsights(selectedProjectRoot, true);
      if (createdId) {
        setSelectedTaskId(createdId);
        await loadTaskDetail(selectedProjectRoot, createdId, true);
      }
    });
  };

  const handleSaveTaskDetails = async () => {
    if (!selectedProjectRoot || !selectedTask) return;
    await withAction("update-task", async () => {
      await invoke("update_task_detail", {
        projectRoot: selectedProjectRoot,
        payload: {
          id: selectedTask.id,
          title: titleDraft,
          description: descriptionDraft,
        },
      });
      const updatedTask = {
        ...selectedTask,
        title: titleDraft,
        description: descriptionDraft,
        metadata: {
          ...selectedTask.metadata,
          updated_at: new Date().toISOString(),
        },
      };
      storeTaskDetail(selectedProjectRoot, updatedTask);
      setSelectedTask(updatedTask);
      applyVisibleTaskPatch(selectedProjectRoot, selectedTask.id, (task) => ({
        ...task,
        title: titleDraft,
      }));
      setNextTask((current) => current && current.id === selectedTask.id ? { ...current, title: titleDraft } : current);
    });
  };

  const handleSetStatus = async () => {
    if (!selectedProjectRoot || !selectedTask) return;
    await withAction("set-status", async () => {
      await invoke("set_task_status", {
        projectRoot: selectedProjectRoot,
        id: selectedTask.id,
        status: statusDraft,
      });
      applyTaskDetailPatch(selectedProjectRoot, selectedTask.id, (task) => ({
        ...task,
        status: statusDraft,
        metadata: {
          ...task.metadata,
          updated_at: new Date().toISOString(),
        },
      }));
      applyVisibleTaskPatch(selectedProjectRoot, selectedTask.id, (task) => {
        const updated = { ...task, status: statusDraft };
        return matchesFilters(updated, statusFilter, priorityFilter) ? updated : null;
      });
      insightsCacheRef.current.delete(selectedProjectRoot);
      void loadProjectInsights(selectedProjectRoot, true);
    });
  };

  const handleSetPriority = async () => {
    if (!selectedProjectRoot || !selectedTask) return;
    await withAction("set-priority", async () => {
      await invoke("set_task_priority", {
        projectRoot: selectedProjectRoot,
        id: selectedTask.id,
        priority: priorityDraft,
      });
      applyTaskDetailPatch(selectedProjectRoot, selectedTask.id, (task) => ({
        ...task,
        priority: priorityDraft,
        metadata: {
          ...task.metadata,
          updated_at: new Date().toISOString(),
        },
      }));
      applyVisibleTaskPatch(selectedProjectRoot, selectedTask.id, (task) => {
        const updated = { ...task, priority: priorityDraft };
        return matchesFilters(updated, statusFilter, priorityFilter) ? updated : null;
      });
      insightsCacheRef.current.delete(selectedProjectRoot);
      void loadProjectInsights(selectedProjectRoot, true);
    });
  };

  const handleAssign = async () => {
    if (!selectedProjectRoot || !selectedTask || !assigneeDraft.trim()) return;
    await withAction("assign-task", async () => {
      await invoke("assign_task", {
        projectRoot: selectedProjectRoot,
        id: selectedTask.id,
        assignee: assigneeDraft.trim(),
        assigneeType: assigneeTypeDraft,
        agentRole: assigneeTypeDraft === "agent" ? assigneeDraft.trim() : null,
        model: null,
      });
      applyTaskDetailPatch(selectedProjectRoot, selectedTask.id, (task) => ({
        ...task,
        assignee: assigneeTypeDraft === "agent"
          ? { type: "agent", agent_role: assigneeDraft.trim(), value: assigneeDraft.trim() }
          : { type: "human", value: assigneeDraft.trim() },
        metadata: {
          ...task.metadata,
          updated_at: new Date().toISOString(),
        },
      }));
    });
  };

  const handleSetDeadline = async (clear = false) => {
    if (!selectedProjectRoot || !selectedTask) return;
    await withAction("set-deadline", async () => {
      await invoke("set_task_deadline", {
        projectRoot: selectedProjectRoot,
        id: selectedTask.id,
        deadline: clear ? null : toRfc3339(deadlineDraft),
      });
      applyTaskDetailPatch(selectedProjectRoot, selectedTask.id, (task) => ({
        ...task,
        deadline: clear ? null : toRfc3339(deadlineDraft),
        metadata: {
          ...task.metadata,
          updated_at: new Date().toISOString(),
        },
      }));
    });
  };

  const handleChecklistToggle = async (item: TaskChecklistItem, completed: boolean) => {
    if (!selectedProjectRoot || !selectedTask) return;
    await withAction(`toggle-${item.id}`, async () => {
      await invoke("update_task_checklist_item", {
        projectRoot: selectedProjectRoot,
        id: selectedTask.id,
        itemId: item.id,
        completed,
      });
      applyTaskDetailPatch(selectedProjectRoot, selectedTask.id, (task) => ({
        ...task,
        checklist: task.checklist.map((checklistItem) => (
          checklistItem.id === item.id
            ? { ...checklistItem, completed }
            : checklistItem
        )),
        metadata: {
          ...task.metadata,
          updated_at: new Date().toISOString(),
        },
      }));
    });
  };

  const handleChecklistAdd = async () => {
    if (!selectedProjectRoot || !selectedTask || !newChecklistItem.trim()) return;
    await withAction("add-checklist", async () => {
      await invoke("add_task_checklist_item", {
        projectRoot: selectedProjectRoot,
        id: selectedTask.id,
        description: newChecklistItem.trim(),
      });
      setNewChecklistItem("");
      detailCacheRef.current.delete(buildDetailCacheKey(selectedProjectRoot, selectedTask.id));
      await loadTaskDetail(selectedProjectRoot, selectedTask.id, true);
    });
  };

  const selectedProject = projects.find((project) => project.root === selectedProjectRoot) ?? null;
  const statusCounts = stats?.by_status ?? {};

  return (
    <div className="h-full flex gap-4 p-6 overflow-hidden bg-background/50">
      {/* Sidebar Task List */}
      <aside className="w-[380px] flex flex-col rounded-2xl border border-white/5 bg-card/20 overflow-hidden backdrop-blur-sm">
        <div className="p-4 border-b border-white/5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-widest text-primary/80">Task Backlog</h2>
            <button onClick={() => refreshCurrentView(true)} className="text-[10px] font-bold text-muted-foreground hover:text-foreground transition-colors uppercase tracking-widest">
              Refresh
            </button>
          </div>

          <div className="space-y-2">
            <select
              value={selectedProjectRoot}
              onChange={(e) => setSelectedProjectRoot(e.target.value)}
              className="w-full h-10 bg-white/5 border border-white/5 rounded-xl px-3 text-sm font-medium outline-none focus:border-primary/50"
            >
              {projects.map((p) => <option key={p.root} value={p.root}>{p.name}</option>)}
            </select>

            <div className="flex gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tasks..."
                className="flex-1 h-10 bg-white/5 border border-white/5 rounded-xl px-3 text-sm outline-none focus:border-primary/50"
              />
              <button 
                onClick={() => { setShowCreateForm(true); setSelectedTaskId(null); }}
                className="h-10 px-4 bg-primary text-primary-foreground rounded-xl text-sm font-bold hover:opacity-90 transition-opacity"
              >
                New
              </button>
            </div>
          </div>

          <div className="flex gap-2">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
              className="flex-1 h-9 bg-white/5 border border-white/5 rounded-lg px-2 text-[10px] font-bold outline-none uppercase tracking-wider">
              <option value="all">All Status</option>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
            </select>
            <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}
              className="flex-1 h-9 bg-white/5 border border-white/5 rounded-lg px-2 text-[10px] font-bold outline-none uppercase tracking-wider">
              <option value="all">All Priority</option>
              {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
          {tasks.map((task) => (
            <button
              key={task.id}
              onClick={() => { setSelectedTaskId(task.id); setShowCreateForm(false); }}
              className={cn(
                "w-full p-4 rounded-xl text-left transition-all duration-200 border",
                selectedTaskId === task.id && !showCreateForm
                  ? "bg-primary/10 border-primary/30"
                  : "border-transparent hover:bg-white/5"
              )}
            >
              <div className="flex justify-between items-start mb-1">
                <span className="text-[10px] font-bold font-mono text-muted-foreground uppercase tracking-widest">{task.id}</span>
                <span className={cn("text-[10px] font-bold uppercase", STATUS_COLORS[normalizeStatus(task.status)] || "text-muted-foreground")}>
                  {normalizeStatus(task.status).replace("_", " ")}
                </span>
              </div>
              <div className="text-sm font-bold text-foreground mb-1 line-clamp-2">{task.title}</div>
              <div className={cn("text-[10px] font-bold uppercase tracking-widest opacity-60", PRIORITY_COLORS[task.priority] || "text-muted-foreground")}>
                {task.priority}
              </div>
            </button>
          ))}
        </div>

        <div className="p-4 border-t border-white/5 flex items-center justify-between bg-card/5">
          <button disabled={page === 0 || loading} onClick={() => setPage(p => p - 1)}
            className="text-[10px] font-bold text-muted-foreground hover:text-foreground disabled:opacity-30 tracking-widest">PREV</button>
          <span className="text-[10px] font-bold text-muted-foreground/50 tracking-widest uppercase">Page {page + 1}</span>
          <button disabled={!hasNextPage || loading} onClick={() => setPage(p => p + 1)}
            className="text-[10px] font-bold text-muted-foreground hover:text-foreground disabled:opacity-30 tracking-widest">NEXT</button>
        </div>
      </aside>

      {/* Detail View */}
      <main className="flex-1 rounded-2xl border border-white/5 bg-card/10 overflow-hidden flex flex-col backdrop-blur-sm">
        {showCreateForm ? (
          <div className="p-8 max-w-3xl mx-auto w-full space-y-8">
            <div>
              <h2 className="text-2xl font-bold text-foreground tracking-tight">Create New Task</h2>
              <p className="text-sm text-muted-foreground mt-1">Define operational requirements for the selected project.</p>
            </div>
            
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60 px-1">Task Title</label>
                <input value={createForm.title} onChange={(e) => setCreateForm(c => ({...c, title: e.target.value}))}
                  placeholder="e.g., Implement OAuth2 flow" className="w-full h-12 bg-white/5 border border-white/10 rounded-xl px-4 text-base outline-none focus:border-primary/50 transition-colors" />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60 px-1">Description</label>
                <textarea value={createForm.description} onChange={(e) => setCreateForm(c => ({...c, description: e.target.value}))}
                  placeholder="Context, acceptance criteria, and technical details..." rows={8} className="w-full bg-white/5 border border-white/10 rounded-xl p-4 text-base outline-none focus:border-primary/50 resize-none transition-colors" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60 px-1">Task Type</label>
                  <select value={createForm.task_type} onChange={(e) => setCreateForm(c => ({...c, task_type: e.target.value}))}
                    className="w-full h-12 bg-white/5 border border-white/10 rounded-xl px-4 text-sm font-bold outline-none uppercase tracking-wider">
                    {TASK_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60 px-1">Priority Level</label>
                  <select value={createForm.priority} onChange={(e) => setCreateForm(c => ({...c, priority: e.target.value}))}
                    className="w-full h-12 bg-white/5 border border-white/10 rounded-xl px-4 text-sm font-bold outline-none uppercase tracking-wider">
                    {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              </div>

              <div className="flex gap-4 pt-4">
                <button onClick={handleCreateTask} disabled={!createForm.title.trim() || !!busyAction}
                  className="px-8 h-12 bg-primary text-primary-foreground rounded-xl font-bold shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 transition-all">
                  Create Task
                </button>
                <button onClick={() => setShowCreateForm(false)} className="px-8 h-12 bg-white/5 text-foreground rounded-xl font-bold hover:bg-white/10 transition-all">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : selectedTask ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            <header className="p-6 border-b border-white/5 flex items-center justify-between shrink-0 bg-white/[0.02]">
              <div className="min-w-0">
                <div className="flex items-center gap-3 mb-1">
                  <span className="text-[10px] font-bold font-mono text-muted-foreground uppercase tracking-widest bg-white/5 px-2 py-0.5 rounded">{selectedTask.id}</span>
                  <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border", 
                    STATUS_COLORS[normalizeStatus(selectedTask.status)] || "border-white/10 text-muted-foreground")}>
                    {normalizeStatus(selectedTask.status).replace("_", " ")}
                  </span>
                </div>
                <h2 className="text-2xl font-bold text-foreground truncate tracking-tight">{selectedTask.title}</h2>
              </div>
              <div className="flex items-center gap-4">
                {busyAction && <span className="text-[10px] font-bold text-primary animate-pulse uppercase tracking-[0.2em]">{busyAction}</span>}
                <button onClick={handleSaveTaskDetails} className="px-6 h-10 bg-primary text-primary-foreground rounded-xl text-sm font-bold hover:scale-[1.02] active:scale-[0.98] transition-all">
                  Save Changes
                </button>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
              <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
                <div className="space-y-10">
                  <section className="space-y-4">
                    <h3 className="text-[10px] font-bold uppercase tracking-[0.25em] text-muted-foreground/40 px-1">Description</h3>
                    <textarea 
                      value={descriptionDraft} 
                      onChange={(e) => setDescriptionDraft(e.target.value)}
                      rows={14}
                      className="w-full bg-white/[0.02] border border-white/5 rounded-2xl p-6 text-base leading-relaxed outline-none focus:border-primary/20 transition-all resize-none shadow-inner"
                    />
                  </section>

                  <section className="space-y-4">
                    <div className="flex items-center justify-between px-1">
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.25em] text-muted-foreground/40">Operational Checklist</h3>
                      <span className="text-[10px] font-bold text-muted-foreground/30 tabular-nums">{selectedTask.checklist.filter(c => c.completed).length} / {selectedTask.checklist.length} COMPLETE</span>
                    </div>
                    <div className="space-y-2">
                      {selectedTask.checklist.map((item) => (
                        <div key={item.id} className="flex items-center gap-4 p-4 rounded-xl bg-white/[0.02] border border-white/5 group hover:border-white/10 transition-colors">
                          <input type="checkbox" checked={item.completed} onChange={(e) => handleChecklistToggle(item, e.target.checked)}
                            className="w-5 h-5 rounded-md border-white/10 bg-white/5 text-primary focus:ring-primary/50 transition-all cursor-pointer" />
                          <span className={cn("text-sm font-medium transition-all", item.completed ? "text-muted-foreground/40 line-through" : "text-foreground/90")}>
                            {item.description}
                          </span>
                        </div>
                      ))}
                      <div className="flex gap-3 mt-6">
                        <input value={newChecklistItem} onChange={(e) => setNewChecklistItem(e.target.value)}
                          placeholder="Add operational requirement..." className="flex-1 h-11 bg-white/5 border border-white/5 rounded-xl px-4 text-sm outline-none focus:border-primary/50 transition-colors" />
                        <button onClick={handleChecklistAdd} className="px-6 h-11 bg-white/10 text-foreground rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-white/20 transition-colors">Add</button>
                      </div>
                    </div>
                  </section>
                </div>

                <aside className="space-y-6">
                  <div className="sticky top-0 space-y-6">
                    <DetailSection title="Lifecycle Control">
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/30 px-1">Operational Status</label>
                          <select value={statusDraft} onChange={(e) => { setStatusDraft(e.target.value); }} onBlur={handleSetStatus}
                            className="w-full h-11 bg-white/5 border border-white/10 rounded-xl px-3 text-xs font-bold outline-none uppercase tracking-widest transition-colors focus:border-primary/30">
                            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
                          </select>
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/30 px-1">Priority Weight</label>
                          <select value={priorityDraft} onChange={(e) => { setPriorityDraft(e.target.value); }} onBlur={handleSetPriority}
                            className="w-full h-11 bg-white/5 border border-white/10 rounded-xl px-3 text-xs font-bold outline-none uppercase tracking-widest transition-colors focus:border-primary/30">
                            {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                          </select>
                        </div>
                      </div>
                    </DetailSection>

                    <DetailSection title="Assignment">
                      <div className="space-y-4">
                        <div className="flex gap-2">
                          <select value={assigneeTypeDraft} onChange={(e) => setAssigneeTypeDraft(e.target.value as "human" | "agent")}
                            className="w-24 h-11 bg-white/5 border border-white/10 rounded-xl px-2 text-[10px] font-bold outline-none uppercase tracking-wider">
                            <option value="human">Human</option>
                            <option value="agent">Agent</option>
                          </select>
                          <input value={assigneeDraft} onChange={(e) => setAssigneeDraft(e.target.value)} placeholder="User or Role"
                            className="flex-1 h-11 bg-white/5 border border-white/10 rounded-xl px-3 text-xs outline-none focus:border-primary/50 transition-colors" />
                        </div>
                        <button onClick={handleAssign} className="w-full h-10 bg-white/10 text-foreground rounded-xl text-[10px] font-bold uppercase tracking-[0.2em] hover:bg-white/20 transition-all active:scale-[0.98]">
                          Update Assignee
                        </button>
                        <div className="px-1 text-[10px] text-muted-foreground/60 italic font-medium">
                          Current: {assigneeSummary(selectedTask.assignee)}
                        </div>
                      </div>
                    </DetailSection>

                    <DetailSection title="Deadlines">
                      <div className="space-y-4">
                        <input type="datetime-local" value={deadlineDraft} onChange={(e) => setDeadlineDraft(e.target.value)}
                          className="w-full h-11 bg-white/5 border border-white/10 rounded-xl px-3 text-xs outline-none transition-colors focus:border-primary/30" />
                        <div className="flex gap-3">
                          <button onClick={() => handleSetDeadline(false)} className="flex-1 h-10 bg-primary/20 text-primary rounded-xl text-[10px] font-bold uppercase tracking-[0.2em] hover:bg-primary/30 transition-all active:scale-[0.98]">Set</button>
                          <button onClick={() => handleSetDeadline(true)} className="flex-1 h-10 bg-white/5 text-muted-foreground rounded-xl text-[10px] font-bold uppercase tracking-[0.2em] hover:bg-white/10 transition-all active:scale-[0.98]">Clear</button>
                        </div>
                      </div>
                    </DetailSection>

                    <div className="p-5 rounded-2xl border border-white/5 bg-white/[0.01] space-y-4">
                      <h4 className="text-[10px] font-bold uppercase tracking-[0.25em] text-muted-foreground/30">Task Metadata</h4>
                      <div className="grid grid-cols-2 gap-y-4 gap-x-2">
                        <MetaInfo label="Created" value={formatDate(selectedTask.metadata?.created_at)} />
                        <MetaInfo label="Updated" value={formatDate(selectedTask.metadata?.updated_at)} />
                        <MetaInfo label="Risk" value={selectedTask.risk || "Low"} />
                        <MetaInfo label="Complexity" value={selectedTask.complexity || "Medium"} />
                      </div>
                    </div>
                  </div>
                </aside>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-12 space-y-6">
            <div className="w-20 h-20 rounded-[2rem] border border-white/10 bg-white/[0.03] flex items-center justify-center text-3xl font-bold text-muted-foreground/20 shadow-2xl">
              TK
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-bold text-foreground/40 tracking-tight">Workbench Idle</h3>
              <p className="text-sm text-muted-foreground/30 max-w-sm leading-relaxed">Select an operational requirement from the backlog to manage its lifecycle or define a new project task.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5 space-y-5">
      <h4 className="text-[10px] font-bold uppercase tracking-[0.25em] text-muted-foreground/40">{title}</h4>
      {children}
    </div>
  );
}

function MetaInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/30">{label}</span>
      <span className="text-[11px] font-semibold text-foreground/60 truncate">{value}</span>
    </div>
  );
}

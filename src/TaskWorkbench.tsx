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
    <div className="grid h-full min-h-0 gap-3 p-3 sm:p-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-[24px] border border-border/80 bg-card/40">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Task Workbench</div>
            <button
              className="ml-auto rounded border border-border px-2 py-1 text-[11px] text-muted-foreground"
              onClick={() => void refreshCurrentView(true)}
            >
              Refresh
            </button>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
            <select
              value={selectedProjectRoot}
              onChange={(event) => {
                setSelectedProjectRoot(event.target.value);
                setShowCreateForm(false);
              }}
              aria-label="Select project"
              className="rounded border border-border bg-background px-3 py-2 text-sm outline-none"
            >
              {projects.map((project) => (
                <option key={project.root} value={project.root}>
                  {project.name}
                </option>
              ))}
            </select>
            <button
              className={cn(
                "rounded border px-3 py-2 text-sm",
                prioritized ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"
              )}
              onClick={() => setPrioritized((current) => !current)}
            >
              Prioritized
            </button>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
            <MetricCard label="Total" value={statsLoading && !stats ? "..." : (stats?.total ?? tasks.length)} />
            <MetricCard label="In Progress" value={statsLoading && !stats ? "..." : (stats?.in_progress ?? 0)} tone="text-chart-1" />
            <MetricCard label="Blocked" value={statsLoading && !stats ? "..." : (stats?.blocked ?? 0)} tone="text-chart-4" />
          </div>
          {!nextTask && nextTaskLoading ? (
            <div className="mt-3 rounded-lg border border-border px-3 py-2 text-[11px] text-muted-foreground">
              Finding next ready task...
            </div>
          ) : nextTask && (
            <div className="mt-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2">
              <button
                className="block w-full text-left"
                onClick={() => {
                  setSelectedTaskId(nextTask.id);
                  setShowCreateForm(false);
                }}
              >
                <div className="text-[10px] uppercase tracking-wide text-primary">Next Ready Task</div>
                <div className="mt-1 text-sm font-medium text-foreground">{nextTask.id} · {nextTask.title}</div>
              </button>
              {nextTaskLoading && (
                <div className="mt-2 text-[10px] text-primary/80">Refreshing next-task recommendation…</div>
              )}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tasks"
              aria-label="Search tasks"
              className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <button
              className="rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
              onClick={() => {
                setShowCreateForm(true);
                setSelectedTaskId(null);
                setSelectedTask(null);
              }}
            >
              New
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              aria-label="Filter tasks by status"
              className="rounded border border-border bg-background px-3 py-2 text-sm outline-none"
            >
              <option value="all">All statuses</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status} ({statusCounts[status] ?? 0})
                </option>
              ))}
            </select>
            <select
              value={priorityFilter}
              onChange={(event) => setPriorityFilter(event.target.value)}
              aria-label="Filter tasks by priority"
              className="rounded border border-border bg-background px-3 py-2 text-sm outline-none"
            >
              <option value="all">All priorities</option>
              {PRIORITY_OPTIONS.map((priority) => (
                <option key={priority} value={priority}>{priority}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          {tasks.length === 0 && loading ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">Loading tasks...</div>
          ) : tasks.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">No tasks for this filter.</div>
          ) : (
            <>
              {loading && (
                <div className="px-2 pb-2 text-[11px] text-muted-foreground">Refreshing task page…</div>
              )}
              {tasks.map((task) => (
                <button
                  key={task.id}
                  className={cn(
                    "mb-1 block w-full rounded-lg border px-3 py-2 text-left",
                    selectedTaskId === task.id && !showCreateForm
                      ? "border-primary bg-primary/10"
                      : "border-transparent hover:border-primary/30 hover:bg-background",
                  )}
                  onClick={() => {
                    setSelectedTaskId(task.id);
                    setShowCreateForm(false);
                  }}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[11px] text-muted-foreground">{task.id}</div>
                      <div className="mt-1 text-sm font-medium text-foreground">{task.title}</div>
                    </div>
                    <div className="text-right">
                      <div className={cn("text-[11px] font-semibold", STATUS_COLORS[normalizeStatus(task.status)] ?? "text-foreground")}>
                        {normalizeStatus(task.status)}
                      </div>
                      <div className={cn("text-[10px]", PRIORITY_COLORS[task.priority] ?? "text-muted-foreground")}>
                        {task.priority}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}
          <div className="sticky bottom-0 mt-2 flex items-center gap-2 border-t border-border bg-card/95 px-2 py-2 backdrop-blur">
            <button
              className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground disabled:opacity-40"
              disabled={page === 0 || loading}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              Prev
            </button>
            <div className="flex-1 text-center text-[11px] text-muted-foreground">
              Page {page + 1}
            </div>
            <button
              className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground disabled:opacity-40"
              disabled={!hasNextPage || loading}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </aside>

      <section className="min-h-0 min-w-0 overflow-auto rounded-[24px] border border-border/80 bg-background">
        <div className="border-b border-border bg-card px-5 py-4">
          <div className="flex items-center gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Project</div>
              <div className="text-lg font-semibold text-foreground">{selectedProject?.name ?? "No project selected"}</div>
            </div>
            {busyAction && (
              <div className="rounded bg-primary/10 px-2 py-1 text-[11px] text-primary">
                {busyAction}
              </div>
            )}
            {feedback && (
              <div className="ml-auto max-w-[520px] text-right text-xs text-chart-4">{feedback}</div>
            )}
          </div>
        </div>

        {showCreateForm ? (
          <div className="mx-auto flex max-w-4xl flex-col gap-4 px-5 py-5">
            <SectionCard title="Create Task" subtitle="Create a task directly from the desktop app.">
              <div className="grid gap-3">
                <input
                  value={createForm.title ?? ""}
                  onChange={(event) => setCreateForm((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Task title"
                  aria-label="Task title"
                  className="rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <textarea
                  value={createForm.description ?? ""}
                  onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))}
                  placeholder="Description"
                  rows={6}
                  aria-label="Task description"
                  className="rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <div className="grid grid-cols-2 gap-3">
                  <select
                    value={createForm.task_type ?? "feature"}
                    onChange={(event) => setCreateForm((current) => ({ ...current, task_type: event.target.value }))}
                    aria-label="Task type"
                    className="rounded border border-border bg-background px-3 py-2 text-sm outline-none"
                  >
                    {TASK_TYPE_OPTIONS.map((taskType) => (
                      <option key={taskType} value={taskType}>{taskType}</option>
                    ))}
                  </select>
                  <select
                    value={createForm.priority ?? "medium"}
                    onChange={(event) => setCreateForm((current) => ({ ...current, priority: event.target.value }))}
                    aria-label="Task priority"
                    className="rounded border border-border bg-background px-3 py-2 text-sm outline-none"
                  >
                    {PRIORITY_OPTIONS.map((priority) => (
                      <option key={priority} value={priority}>{priority}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                    disabled={!createForm.title?.trim() || busyAction !== null}
                    onClick={handleCreateTask}
                  >
                    Create
                  </button>
                  <button
                    className="rounded border border-border px-4 py-2 text-sm text-muted-foreground"
                    onClick={() => setShowCreateForm(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </SectionCard>
          </div>
        ) : selectedTask ? (
          <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-5">
            {detailLoading && (
              <div className="rounded-lg border border-border bg-card px-4 py-2 text-xs text-muted-foreground">
                Refreshing task detail…
              </div>
            )}
            <SectionCard
              title={`${selectedTask.id} · ${selectedTask.title}`}
              subtitle={`Assignee: ${assigneeSummary(selectedTask.assignee)} · Updated: ${formatDate(selectedTask.metadata?.updated_at)}`}
            >
              <div className="grid gap-3">
                <input
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  aria-label="Edit task title"
                  className="rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <textarea
                  value={descriptionDraft}
                  onChange={(event) => setDescriptionDraft(event.target.value)}
                  rows={7}
                  aria-label="Edit task description"
                  className="rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  <span>Type: {selectedTask.type ?? "unknown"}</span>
                  <span>Branch: {selectedTask.branch_name ?? "None"}</span>
                  <span>Deadline: {formatDate(selectedTask.deadline)}</span>
                  <span>Checklist: {selectedTask.checklist.length}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                    disabled={busyAction !== null}
                    onClick={handleSaveTaskDetails}
                  >
                    Save Title / Description
                  </button>
                </div>
              </div>
            </SectionCard>

            <div className="grid gap-4 lg:grid-cols-2">
              <SectionCard title="Status" subtitle="Use task-specific AO actions instead of raw CLI flags.">
                <div className="flex gap-2">
                  <select
                    value={statusDraft}
                    onChange={(event) => setStatusDraft(event.target.value)}
                    aria-label="Select task status"
                    className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm outline-none"
                  >
                    {STATUS_OPTIONS.map((status) => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                  </select>
                  <button
                    className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                    disabled={busyAction !== null}
                    onClick={handleSetStatus}
                  >
                    Apply
                  </button>
                </div>
              </SectionCard>

              <SectionCard title="Priority" subtitle="Tune scheduling pressure directly from the workbench.">
                <div className="flex gap-2">
                  <select
                    value={priorityDraft}
                    onChange={(event) => setPriorityDraft(event.target.value)}
                    aria-label="Select task priority"
                    className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm outline-none"
                  >
                    {PRIORITY_OPTIONS.map((priority) => (
                      <option key={priority} value={priority}>{priority}</option>
                    ))}
                  </select>
                  <button
                    className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                    disabled={busyAction !== null}
                    onClick={handleSetPriority}
                  >
                    Apply
                  </button>
                </div>
              </SectionCard>

              <SectionCard title="Assignee" subtitle="Assign humans or agents without dropping to the CLI.">
                <div className="grid gap-2">
                  <div className="grid grid-cols-[120px_1fr_auto] gap-2">
                    <select
                      value={assigneeTypeDraft}
                      onChange={(event) => setAssigneeTypeDraft(event.target.value as "human" | "agent")}
                      aria-label="Choose assignee type"
                      className="rounded border border-border bg-background px-3 py-2 text-sm outline-none"
                    >
                      <option value="human">human</option>
                      <option value="agent">agent</option>
                    </select>
                    <input
                      value={assigneeDraft}
                      onChange={(event) => setAssigneeDraft(event.target.value)}
                      placeholder={assigneeTypeDraft === "agent" ? "agent role" : "user id"}
                      aria-label={assigneeTypeDraft === "agent" ? "Agent role" : "User id"}
                      className="rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                    <button
                      className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                      disabled={!assigneeDraft.trim() || busyAction !== null}
                      onClick={handleAssign}
                    >
                      Assign
                    </button>
                  </div>
                  <div className="text-[11px] text-muted-foreground">Current: {assigneeSummary(selectedTask.assignee)}</div>
                </div>
              </SectionCard>

              <SectionCard title="Deadline" subtitle="Set or clear the task deadline with AO’s deadline command.">
                <div className="grid grid-cols-[1fr_auto_auto] gap-2">
                  <input
                    type="datetime-local"
                    value={deadlineDraft}
                    onChange={(event) => setDeadlineDraft(event.target.value)}
                    aria-label="Task deadline"
                    className="rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <button
                    className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                    disabled={busyAction !== null}
                    onClick={() => handleSetDeadline(false)}
                  >
                    Apply
                  </button>
                  <button
                    className="rounded border border-border px-4 py-2 text-sm text-muted-foreground disabled:opacity-50"
                    disabled={busyAction !== null}
                    onClick={() => handleSetDeadline(true)}
                  >
                    Clear
                  </button>
                </div>
              </SectionCard>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
              <SectionCard title={`Checklist (${selectedTask.checklist.length})`} subtitle="Toggle items or add more checklist work.">
                <div className="grid gap-2">
                  {selectedTask.checklist.length === 0 && (
                    <div className="text-sm text-muted-foreground">No checklist items yet.</div>
                  )}
                  {selectedTask.checklist.map((item) => (
                    <label key={item.id} className="flex items-center gap-3 rounded border border-border bg-background px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={item.completed}
                        onChange={(event) => handleChecklistToggle(item, event.target.checked)}
                      />
                      <span className={cn(item.completed && "text-muted-foreground line-through")}>{item.description}</span>
                    </label>
                  ))}
                  <div className="grid grid-cols-[1fr_auto] gap-2 pt-2">
                    <input
                      value={newChecklistItem}
                      onChange={(event) => setNewChecklistItem(event.target.value)}
                      placeholder="New checklist item"
                      aria-label="New checklist item"
                      className="rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                    <button
                      className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                      disabled={!newChecklistItem.trim() || busyAction !== null}
                      onClick={handleChecklistAdd}
                    >
                      Add
                    </button>
                  </div>
                </div>
              </SectionCard>

              <SectionCard title="Metadata" subtitle="High-signal fields from the AO task record.">
                <div className="grid gap-2 text-sm">
                  <MetaRow label="Created" value={formatDate(selectedTask.metadata?.created_at)} />
                  <MetaRow label="Updated" value={formatDate(selectedTask.metadata?.updated_at)} />
                  <MetaRow label="Started" value={formatDate(selectedTask.metadata?.started_at)} />
                  <MetaRow label="Completed" value={formatDate(selectedTask.metadata?.completed_at)} />
                  <MetaRow label="Risk" value={selectedTask.risk ?? "unknown"} />
                  <MetaRow label="Scope" value={selectedTask.scope ?? "unknown"} />
                  <MetaRow label="Complexity" value={selectedTask.complexity ?? "unknown"} />
                  <MetaRow label="Worktree" value={selectedTask.worktree_path ?? "None"} />
                </div>
              </SectionCard>
            </div>
          </div>
        ) : detailLoading ? (
          <div className="px-5 py-8 text-sm text-muted-foreground">Loading task detail...</div>
        ) : (
          <div className="px-5 py-8 text-sm text-muted-foreground">
            {projects.length === 0 ? "No AO projects discovered." : "Select a task or create a new one."}
          </div>
        )}
      </section>
    </div>
  );
}

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {subtitle && <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
      </div>
      {children}
    </section>
  );
}

function MetricCard({ label, value, tone = "text-foreground" }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded border border-border bg-background px-3 py-2">
      <div className={cn("text-lg font-semibold", tone)}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 rounded border border-border bg-background px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="break-words text-foreground">{value}</div>
    </div>
  );
}

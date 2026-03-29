import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";
import type {
  FleetProject,
  StreamEvent,
  ProjectConfig,
  TaskInfo,
  CommitInfo,
  GlobalAoInfo,
  FleetTeamSnapshot,
} from "./types";
import { LogEventList, type LogGroupMode } from "./LogEventList";

const STATUS_COLORS: Record<string, string> = {
  running: "#5d9a80",
  paused: "#8c6b3d",
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

const TEAM_POLICY_PRESETS = [
  { label: "Manual Only", policy: "manual_only" },
  { label: "Always On", policy: "always_on" },
  { label: "Business Hours", policy: "business_hours" },
  { label: "Nightly", policy: "nightly" },
  { label: "Burst On Backlog", policy: "burst_on_backlog" },
] as const;

interface Props {
  projects: FleetProject[];
  events: StreamEvent[];
  globalAoInfo?: GlobalAoInfo | null;
  onFleetRefresh: () => Promise<void>;
}
interface TeamBucket {
  teamId: string;
  teamSlug: string;
  teamName: string;
  projects: FleetProject[];
  enabledCount: number;
  runningCount: number;
  idleCount: number;
  driftCount: number;
}

type StreamFilter =
  | { type: "all" }
  | { type: "active-runs"; workflowIds: string[]; workflowRefs: string[]; taskIds: string[]; label: string }
  | { type: "workflow"; value: string }
  | { type: "run"; workflowId: string; taskId?: string; workflowRef: string; label: string };
type ActiveRunsStreamFilter = Extract<StreamFilter, { type: "active-runs" }>;
const PROJECT_DETAIL_MAX_EVENTS = 4000;

function renderReconcileTarget(target: Record<string, unknown>) {
  const resolution = typeof target.resolution === "string" ? target.resolution : null;
  const transport = typeof target.transport === "string" ? target.transport : null;
  const host = [
    typeof target.host_name === "string" ? target.host_name : null,
    typeof target.host_slug === "string" ? target.host_slug : null,
    typeof target.host_address === "string" ? target.host_address : null,
    typeof target.host_id === "string" ? target.host_id : null,
  ].find(Boolean);

  if (!resolution && !transport && !host) return null;

  return (
    <div className="mt-3 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
      <div className="rounded-lg border border-white/5 bg-black/10 px-3 py-2">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Resolution</div>
        <div className="mt-1 text-foreground">{resolution ?? "n/a"}</div>
      </div>
      <div className="rounded-lg border border-white/5 bg-black/10 px-3 py-2">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Transport</div>
        <div className="mt-1 text-foreground">{transport ?? "n/a"}</div>
      </div>
      <div className="rounded-lg border border-white/5 bg-black/10 px-3 py-2">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Target Host</div>
        <div className="mt-1 text-foreground">{host ?? "local"}</div>
      </div>
    </div>
  );
}

function renderCommandResult(commandResult?: Record<string, unknown> | null) {
  if (!commandResult || Object.keys(commandResult).length === 0) return null;

  const state = typeof commandResult.state === "string" ? commandResult.state : null;
  const message = typeof commandResult.message === "string" ? commandResult.message : null;

  return (
    <div className="mt-3 rounded-lg border border-white/5 bg-black/10 px-3 py-2 text-[11px] text-muted-foreground">
      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Command Result</div>
      <div className="mt-1 text-foreground">{message ?? state ?? "No command payload returned."}</div>
    </div>
  );
}

function getEventRunId(event: StreamEvent) {
  return typeof event.run_id === "string"
    ? event.run_id
    : typeof event.meta?.run_id === "string"
      ? event.meta.run_id
      : null;
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

export function FleetOverview({ projects, events, globalAoInfo, onFleetRefresh }: Props) {
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
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

  const teamBuckets = useMemo<TeamBucket[]>(() => {
    const grouped = new Map<string, TeamBucket>();

    for (const project of projects) {
      const existing = grouped.get(project.teamId);
      if (existing) {
        existing.projects.push(project);
      } else {
        grouped.set(project.teamId, {
          teamId: project.teamId,
          teamSlug: project.teamSlug,
          teamName: project.teamName,
          projects: [project],
          enabledCount: 0,
          runningCount: 0,
          idleCount: 0,
          driftCount: 0,
        });
      }
    }

    return [...grouped.values()]
      .map((team) => {
        const sortedProjects = [...team.projects].sort((left, right) => {
          return Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name);
        });
        const enabledCount = sortedProjects.filter((project) => project.enabled).length;
        const runningCount = sortedProjects.filter((project) => project.health?.status === "running").length;
        const idleCount = sortedProjects.filter((project) => !project.enabled).length;
        const driftCount = sortedProjects.filter((project) => project.enabled && project.health?.status !== "running").length;

        return {
          ...team,
          projects: sortedProjects,
          enabledCount,
          runningCount,
          idleCount,
          driftCount,
        };
      })
      .sort((left, right) => left.teamName.localeCompare(right.teamName));
  }, [projects]);
  const selectedTeam = useMemo(
    () => teamBuckets.find((team) => team.teamId === selectedTeamId) ?? null,
    [selectedTeamId, teamBuckets],
  );

  const totalAgents = projects.reduce((s, p) => s + (p.health?.active_agents || 0), 0);
  const totalPool = projects.reduce((s, p) => s + (p.health?.pool_size || 0), 0);
  const totalQueue = projects.reduce((s, p) => s + (p.health?.queued_tasks || 0), 0);
  const totalTasks = projects.reduce((s, p) => s + (p.tasks?.total || 0), 0);
  const enabledProjects = projects.filter((project) => project.enabled).length;
  const driftProjects = projects.filter((project) => project.enabled && project.health?.status !== "running").length;
  const activeTeams = teamBuckets.filter((team) => team.runningCount > 0).length;

  const statusData = Object.entries(
    projects.reduce<Record<string, number>>((acc, p) => {
      const s = p.health?.status || "offline";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {})
  ).map(([name, value]) => ({ name, value }));

  const teamChartData = teamBuckets.map((team) => ({
    name: team.teamSlug.replace("launchpad-", "lp-"),
    running: team.runningCount,
    drift: team.driftCount,
    idle: team.idleCount,
  }));

  const attentionTeams = useMemo(() => {
    return teamBuckets
      .map((team) => {
        const topProject = [...team.projects]
          .map((project) => ({
            project,
            state: getProjectState(project, eventsByProjectRoot.get(project.root) ?? []),
          }))
          .sort((left, right) => right.state.score - left.state.score)[0];

        return {
          team,
          topProject,
          score: Math.max(team.driftCount >= 1 ? 4 : 1, topProject?.state.score ?? 1),
        };
      })
      .filter(({ score }) => score >= 3)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3);
  }, [eventsByProjectRoot, teamBuckets]);

  if (selected) {
    return (
      <ProjectDetail
        project={selected}
        events={eventsByProjectRoot.get(selected.root) ?? []}
        onBack={() => setSelectedRoot(null)}
      />
    );
  }

  if (selectedTeam) {
    return (
      <TeamDetail
        team={selectedTeam}
        onBack={() => setSelectedTeamId(null)}
        onProjectClick={(root) => setSelectedRoot(root)}
        onFleetRefresh={onFleetRefresh}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="max-w-[1600px] mx-auto p-6 space-y-8">
        {/* KPI Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KPICard label="Teams" value={teamBuckets.length} />
          <KPICard label="Enabled Projects" value={`${enabledProjects}/${projects.length}`} />
          <KPICard label="Running Teams" value={`${activeTeams}/${teamBuckets.length}`} />
          <KPICard label="Fleet Drift" value={driftProjects} tone={driftProjects > 0 ? "warning" : "default"} />
        </div>

        {/* Attention Lane */}
        {attentionTeams.length > 0 && (
          <section className="space-y-4">
            <div className="flex items-end justify-between px-1">
              <div>
                <h3 className="text-sm font-bold uppercase tracking-widest text-primary/80">Attention Required</h3>
                <p className="text-sm text-muted-foreground mt-1">Teams with drift or unhealthy project signals.</p>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {attentionTeams.map(({ team, topProject, score }) => (
                <button
                  key={`${team.teamId}:attention`}
                  onClick={() => setSelectedTeamId(team.teamId)}
                  className="group relative flex flex-col p-5 text-left rounded-2xl border border-white/5 bg-white/5 hover:bg-white/10 transition-all duration-300"
                >
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <span className="text-base font-bold text-foreground group-hover:text-primary transition-colors">{team.teamName}</span>
                      <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">{team.teamSlug}</div>
                    </div>
                    <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border", score >= 4 ? stateToneClasses("blocked") : stateToneClasses("degraded"))}>
                      {team.driftCount > 0 ? `${team.driftCount} drifting` : topProject?.state.label ?? "Watch"}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2 flex-1 mb-4">
                    {team.driftCount > 0
                      ? `${team.driftCount} enabled project${team.driftCount === 1 ? "" : "s"} are not currently running.`
                      : topProject?.state.summary ?? "This team needs operator attention."}
                  </p>
                  <div className="pt-4 border-t border-white/5 flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">
                      {topProject ? `Open ${team.teamName}` : "Inspect team"}
                    </span>
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
              <div className="mb-6 flex items-end justify-between gap-4">
                <div>
                  <h3 className="text-sm font-bold text-foreground">Team Activity</h3>
                  <p className="mt-1 text-xs text-muted-foreground">Running, drifting, and idle project mix by team.</p>
                </div>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  <LegendDot color="#5d9a80" label="Running" />
                  <LegendDot color="#c3893d" label="Drift" />
                  <LegendDot color="#5a6474" label="Idle" />
                </div>
              </div>
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={teamChartData} barSize={22}>
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "#6b7280", fontSize: 12 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: "#6b7280", fontSize: 12 }} />
                    <Tooltip 
                      cursor={{ fill: "rgba(255,255,255,0.05)" }}
                      contentStyle={{ background: "#0f1115", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "12px" }}
                    />
                    <Bar dataKey="running" stackId="a" fill={STATUS_COLORS.running} />
                    <Bar dataKey="drift" stackId="a" fill={TASK_COLORS.blocked} />
                    <Bar dataKey="idle" stackId="a" fill={STATUS_COLORS.stopped} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Team List */}
            <div className="rounded-2xl border border-white/5 bg-card/20 overflow-hidden">
              <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
                <h3 className="text-sm font-bold text-foreground">Company Teams</h3>
                <span className="text-xs text-muted-foreground">{teamBuckets.length} teams / {projects.length} projects</span>
              </div>
              <div className="divide-y divide-white/5">
                {teamBuckets.map((team) => (
                  <TeamSection
                    key={team.teamId}
                    team={team}
                    eventsByProjectRoot={eventsByProjectRoot}
                    onTeamClick={() => setSelectedTeamId(team.teamId)}
                    onProjectClick={(root) => setSelectedRoot(root)}
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

            <div className="rounded-2xl border border-white/5 bg-card/20 p-6">
              <h3 className="text-sm font-bold text-foreground mb-4">Company Pulse</h3>
              <div className="space-y-3 text-xs">
                <MiniStat label="Active Agents" value={`${totalAgents}/${totalPool}`} tone="text-foreground" />
                <MiniStat label="Fleet Queue" value={totalQueue} tone={totalQueue > 20 ? "text-chart-4" : "text-foreground"} />
                <MiniStat label="Tasks Observed" value={totalTasks} tone="text-foreground" />
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

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function TeamSection({
  team,
  eventsByProjectRoot,
  onTeamClick,
  onProjectClick,
}: {
  team: TeamBucket;
  eventsByProjectRoot: Map<string, StreamEvent[]>;
  onTeamClick: () => void;
  onProjectClick: (root: string) => void;
}) {
  return (
    <section className="px-6 py-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <button onClick={onTeamClick} className="text-left group">
          <div className="text-sm font-bold text-foreground">{team.teamName}</div>
          <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 group-hover:text-primary/70">{team.teamSlug}</div>
        </button>
        <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-wider">
          <span className="rounded border border-chart-1/30 bg-chart-1/10 px-2 py-1 text-chart-1">
            {team.runningCount} running
          </span>
          <span className={cn(
            "rounded border px-2 py-1",
            team.driftCount > 0
              ? "border-chart-4/30 bg-chart-4/10 text-chart-4"
              : "border-white/10 bg-white/5 text-muted-foreground"
          )}>
            {team.driftCount} drift
          </span>
          <span className="rounded border border-white/10 bg-white/5 px-2 py-1 text-muted-foreground">
            {team.idleCount} idle
          </span>
          <button
            onClick={onTeamClick}
            className="rounded border border-primary/20 bg-primary/10 px-2 py-1 text-primary transition-colors hover:bg-primary/15"
          >
            open team
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-white/5">
        {team.projects.map((project) => (
          <OverviewProjectRow
            key={project.root}
            project={project}
            events={eventsByProjectRoot.get(project.root) ?? []}
            onClick={() => onProjectClick(project.root)}
          />
        ))}
      </div>
    </section>
  );
}

function TeamDetail({
  team,
  onBack,
  onProjectClick,
  onFleetRefresh,
}: {
  team: TeamBucket;
  onBack: () => void;
  onProjectClick: (root: string) => void;
  onFleetRefresh: () => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<FleetTeamSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [schedulePreset, setSchedulePreset] = useState("manual_only");
  const [scheduleTimezone, setScheduleTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [hostSelection, setHostSelection] = useState("local");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteSummary, setNoteSummary] = useState("");
  const [noteBody, setNoteBody] = useState("");

  const loadSnapshot = async () => {
    setLoading(true);
    setError(null);
    try {
      const value = await invoke<FleetTeamSnapshot>("get_team_snapshot", { teamId: team.teamId });
      setSnapshot(value);
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSnapshot();
  }, [team.teamId]);

  useEffect(() => {
    const activeSchedule = snapshot?.schedules.find((schedule) => schedule.enabled) ?? snapshot?.schedules[0];
    if (activeSchedule) {
      setSchedulePreset(activeSchedule.policyKind);
      setScheduleTimezone(activeSchedule.timezone);
    }
    const hostId = snapshot?.placements[0]?.hostId;
    setHostSelection(hostId ?? "local");
  }, [snapshot]);

  const runTeamAction = async (kind: "start" | "stop" | "pause" | "resume" | "enable" | "disable") => {
    setActionState(kind);
    setActionError(null);
    try {
      if (kind === "enable" || kind === "disable") {
        await invoke("set_team_enabled", { teamId: team.teamId, enabled: kind === "enable" });
      } else {
        await invoke("run_team_daemon_action", { teamId: team.teamId, action: kind });
      }
      await onFleetRefresh();
      await loadSnapshot();
    } catch (invokeError) {
      setActionError(String(invokeError));
    } finally {
      setActionState(null);
    }
  };

  const placementByProjectId = useMemo(() => {
    const map = new Map<string, FleetTeamSnapshot["placements"][number]>();
    snapshot?.placements.forEach((placement) => map.set(placement.projectId, placement));
    return map;
  }, [snapshot]);

  const daemonStatusByProjectId = useMemo(() => {
    const map = new Map<string, FleetTeamSnapshot["daemonStatuses"][number]>();
    snapshot?.daemonStatuses.forEach((status) => map.set(status.projectId, status));
    return map;
  }, [snapshot]);

  const reconcileSummary = useMemo(() => {
    const results = snapshot?.reconcilePreview.results ?? [];
    return {
      total: results.length,
      actions: results.filter((result) => result.action).length,
      running: results.filter((result) => result.desiredState === "running").length,
      paused: results.filter((result) => result.desiredState === "paused").length,
      stopped: results.filter((result) => result.desiredState === "stopped").length,
    };
  }, [snapshot]);

  const runMutation = async (stateKey: string, operation: () => Promise<void>) => {
    setActionState(stateKey);
    setActionError(null);
    try {
      await operation();
      await onFleetRefresh();
      await loadSnapshot();
    } catch (invokeError) {
      setActionError(String(invokeError));
    } finally {
      setActionState(null);
    }
  };

  const saveSchedule = async (enabled: boolean) => {
    await runMutation(enabled ? "schedule-save" : "schedule-disable", async () => {
      await invoke("save_team_schedule", {
        teamId: team.teamId,
        policyKind: schedulePreset,
        timezone: scheduleTimezone,
        enabled,
      });
    });
  };

  const savePolicyPreset = async (policyKind: string, enabled: boolean) => {
    setSchedulePreset(policyKind);
    await runMutation(`policy-${policyKind}`, async () => {
      await invoke("save_team_schedule", {
        teamId: team.teamId,
        policyKind,
        timezone: scheduleTimezone,
        enabled,
      });
    });
  };

  const reconcileTeam = async (apply: boolean) => {
    await runMutation(apply ? "reconcile-apply" : "reconcile-preview", async () => {
      await invoke("reconcile_team", { teamId: team.teamId, apply });
    });
  };

  const saveHostPlacement = async () => {
    await runMutation("host-save", async () => {
      await invoke("set_team_host", {
        teamId: team.teamId,
        hostId: hostSelection === "local" ? null : hostSelection,
      });
    });
  };

  const saveKnowledgeNote = async () => {
    if (!noteTitle.trim() || !noteSummary.trim() || !noteBody.trim()) {
      setActionError("Title, summary, and note body are required.");
      return;
    }

    await runMutation("knowledge-save", async () => {
      await invoke("create_team_knowledge_note", {
        teamId: team.teamId,
        title: noteTitle,
        summary: noteSummary,
        body: noteBody,
      });
      setNoteTitle("");
      setNoteSummary("");
      setNoteBody("");
    });
  };

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="max-w-[1600px] mx-auto p-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-3">
            <button onClick={onBack} className="text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-primary">
              ← Back To Company
            </button>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-primary/70">{team.teamSlug}</div>
              <h2 className="mt-2 text-3xl font-bold text-foreground">{team.teamName}</h2>
              <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
                {snapshot?.team.mission || "No team mission has been recorded yet."}
              </p>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { label: "Enable Team", action: "enable" as const },
              { label: "Disable Team", action: "disable" as const },
              { label: "Start Enabled", action: "start" as const },
              { label: "Stop Team", action: "stop" as const },
              { label: "Pause Team", action: "pause" as const },
              { label: "Resume Team", action: "resume" as const },
            ].map((control) => (
              <button
                key={control.action}
                onClick={() => void runTeamAction(control.action)}
                disabled={actionState !== null}
                className="rounded-xl border border-primary/20 bg-primary/10 px-4 py-3 text-sm font-bold text-primary transition-colors hover:bg-primary/15 disabled:cursor-wait disabled:opacity-60"
              >
                {actionState === control.action ? "Working…" : control.label}
              </button>
            ))}
          </div>
        </div>

        {actionError && (
          <div className="rounded-2xl border border-chart-5/30 bg-chart-5/10 px-4 py-3 text-sm text-chart-5">
            {actionError}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <KPICard label="Projects" value={team.projects.length} />
          <KPICard label="Enabled" value={team.enabledCount} />
          <KPICard label="Running" value={team.runningCount} tone={team.runningCount > 0 ? "default" : "warning"} />
          <KPICard label="Drift" value={team.driftCount} tone={team.driftCount > 0 ? "warning" : "default"} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <KPICard label="Reconcile Actions" value={reconcileSummary.actions} tone={reconcileSummary.actions > 0 ? "warning" : "default"} />
          <KPICard label="Desired Running" value={reconcileSummary.running} />
          <KPICard label="Desired Paused" value={reconcileSummary.paused} />
          <KPICard label="Desired Stopped" value={reconcileSummary.stopped} />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]">
          <section className="rounded-2xl border border-white/5 bg-card/20 overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
              <h3 className="text-sm font-bold text-foreground">Team Projects</h3>
              <span className="text-xs text-muted-foreground">{team.projects.length} tracked</span>
            </div>
            <div className="divide-y divide-white/5">
              {team.projects.map((project) => {
                const placement = snapshot?.projects
                  ? placementByProjectId.get(snapshot.projects.find((entry) => entry.root === project.root)?.id ?? "")
                  : undefined;
                const status = snapshot?.projects
                  ? daemonStatusByProjectId.get(snapshot.projects.find((entry) => entry.root === project.root)?.id ?? "")
                  : undefined;
                return (
                  <button
                    key={project.root}
                    onClick={() => onProjectClick(project.root)}
                    className="grid w-full grid-cols-[1fr_120px_160px] gap-4 px-6 py-4 text-left transition-colors hover:bg-white/[0.03]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold text-foreground">{project.name}</span>
                        <span className={cn(
                          "rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                          project.enabled ? "border-primary/20 bg-primary/10 text-primary" : "border-white/10 bg-white/5 text-muted-foreground",
                        )}>
                          {project.enabled ? "enabled" : "disabled"}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground line-clamp-1">{project.root}</div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <div className="font-bold uppercase tracking-widest text-[10px]">
                        {status?.observedState ?? project.health?.status ?? "offline"}
                      </div>
                      <div className="mt-1">
                        target {status?.desiredState ?? (project.enabled ? "running" : "stopped")}
                      </div>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <div>{placement?.hostName ?? "local host"}</div>
                      <div className="mt-1">{placement?.hostStatus ?? "unplaced"}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <div className="space-y-6">
            <section className="rounded-2xl border border-white/5 bg-card/20 p-6">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-foreground">Operating Policy</h3>
                <span className="text-xs text-muted-foreground">{snapshot?.schedules.length ?? 0}</span>
              </div>
              <div className="mt-4 space-y-4">
                <div className="flex flex-wrap gap-2">
                  {TEAM_POLICY_PRESETS.map((preset) => (
                    <button
                      key={preset.policy}
                      onClick={() => void savePolicyPreset(preset.policy, true)}
                      disabled={actionState !== null}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-foreground transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
                    >
                      {actionState === `policy-${preset.policy}` ? "Working…" : preset.label}
                    </button>
                  ))}
                  <button
                    onClick={() => void savePolicyPreset("manual_only", false)}
                    disabled={actionState !== null}
                    className="rounded-lg border border-chart-5/30 bg-chart-5/10 px-3 py-1.5 text-[11px] font-semibold text-chart-5 transition-colors hover:bg-chart-5/15 disabled:cursor-wait disabled:opacity-60"
                  >
                    {actionState === "policy-manual_only" ? "Freezing…" : "Freeze Team"}
                  </button>
                </div>
                <div className="grid gap-3">
                  <label className="space-y-2 text-xs text-muted-foreground">
                    <span className="font-bold uppercase tracking-widest">Policy</span>
                    <select
                      value={schedulePreset}
                      onChange={(event) => setSchedulePreset(event.target.value)}
                      className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-foreground outline-none"
                    >
                      <option value="manual_only">manual only</option>
                      <option value="always_on">always on</option>
                      <option value="business_hours">business hours</option>
                      <option value="nightly">nightly</option>
                      <option value="burst_on_backlog">burst on backlog</option>
                    </select>
                  </label>
                  <label className="space-y-2 text-xs text-muted-foreground">
                    <span className="font-bold uppercase tracking-widest">Timezone</span>
                    <input
                      value={scheduleTimezone}
                      onChange={(event) => setScheduleTimezone(event.target.value)}
                      className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-foreground outline-none"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => void saveSchedule(true)}
                      disabled={actionState !== null}
                      className="rounded-xl border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-bold text-primary transition-colors hover:bg-primary/15 disabled:cursor-wait disabled:opacity-60"
                    >
                      {actionState === "schedule-save" ? "Saving…" : "Save Policy"}
                    </button>
                    <button
                      onClick={() => void saveSchedule(false)}
                      disabled={actionState !== null}
                      className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-bold text-muted-foreground transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
                    >
                      {actionState === "schedule-disable" ? "Disabling…" : "Disable Policy"}
                    </button>
                  </div>
                </div>
                {loading && <div className="text-sm text-muted-foreground">Loading team state…</div>}
                {error && <div className="text-sm text-chart-5">{error}</div>}
                {!loading && !error && snapshot?.schedules.length === 0 && (
                  <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4 text-sm text-muted-foreground">
                    No schedules configured yet for this team.
                  </div>
                )}
                {snapshot?.schedules.map((schedule) => (
                  <div key={schedule.id} className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-bold text-foreground">{schedule.policyKind.replace(/_/g, " ")}</span>
                      <span className={cn(
                        "rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                        schedule.enabled ? "border-chart-1/30 bg-chart-1/10 text-chart-1" : "border-white/10 bg-white/5 text-muted-foreground",
                      )}>
                        {schedule.enabled ? "active" : "off"}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">{schedule.timezone}</div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {describeScheduleWindows(schedule.policyKind, schedule.windows)}
                    </div>
                  </div>
                ))}
              </div>
            </section>

	            <section className="rounded-2xl border border-white/5 bg-card/20 p-6">
	              <div className="flex items-center justify-between">
	                <h3 className="text-sm font-bold text-foreground">Reconcile</h3>
	                <span className="text-xs text-muted-foreground">
	                  {reconcileSummary.total}
	                  {snapshot?.reconcilePreview.evaluatedAt ? ` · ${new Date(snapshot.reconcilePreview.evaluatedAt).toLocaleString()}` : ""}
	                </span>
	              </div>
	              <div className="mt-4 space-y-4">
                <div className="flex gap-2">
                  <button
                    onClick={() => void reconcileTeam(false)}
                    disabled={actionState !== null}
                    className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-bold text-foreground transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
                  >
                    {actionState === "reconcile-preview" ? "Previewing…" : "Preview Reconcile"}
                  </button>
                  <button
                    onClick={() => void reconcileTeam(true)}
                    disabled={actionState !== null}
                    className="rounded-xl border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-bold text-primary transition-colors hover:bg-primary/15 disabled:cursor-wait disabled:opacity-60"
                  >
                    {actionState === "reconcile-apply" ? "Reconciling…" : "Reconcile Now"}
                  </button>
                </div>
                <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4 text-sm text-muted-foreground">
                  {reconcileSummary.actions > 0
                    ? `${reconcileSummary.actions} project action${reconcileSummary.actions === 1 ? "" : "s"} would run for this team.`
                    : "This team is already aligned with its current operating policy."}
                </div>
	                {snapshot?.reconcilePreview.results.slice(0, 6).map((result) => (
	                  <div key={`${result.projectId}:${result.projectRoot}`} className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
	                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-bold text-foreground">{result.projectRoot.split("/").pop()}</span>
                      <span className={cn(
                        "rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                        result.action ? "border-chart-4/30 bg-chart-4/10 text-chart-4" : "border-chart-1/30 bg-chart-1/10 text-chart-1",
                      )}>
                        {result.action ?? "aligned"}
                      </span>
                    </div>
	                    <div className="mt-2 text-xs text-muted-foreground">
	                      desired {result.desiredState} · observed {result.observedState ?? "unknown"}
	                    </div>
	                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
	                      <span className="rounded border border-white/10 bg-black/10 px-2 py-1">
	                        backlog {result.backlogCount ?? 0}
	                      </span>
	                      <span className="rounded border border-white/10 bg-black/10 px-2 py-1">
	                        schedules {result.scheduleIds.length}
	                      </span>
	                    </div>
	                    <div className="mt-2 text-xs text-muted-foreground">
	                      {describeTeamReconcileResult(result)}
	                    </div>
	                    {renderReconcileTarget(result.target)}
	                    {renderCommandResult(result.commandResult)}
	                  </div>
	                ))}
	              </div>
            </section>

            <section className="rounded-2xl border border-white/5 bg-card/20 p-6">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-foreground">Host Placement</h3>
                <span className="text-xs text-muted-foreground">{snapshot?.placements.length ?? 0}</span>
              </div>
              <div className="mt-4 space-y-4">
                <div className="grid gap-3">
                  <label className="space-y-2 text-xs text-muted-foreground">
                    <span className="font-bold uppercase tracking-widest">Execution Host</span>
                    <select
                      value={hostSelection}
                      onChange={(event) => setHostSelection(event.target.value)}
                      className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-foreground outline-none"
                    >
                      <option value="local">local host</option>
                      {(snapshot?.hosts ?? []).map((host) => (
                        <option key={host.id} value={host.id}>
                          {host.name} · {host.address}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    onClick={() => void saveHostPlacement()}
                    disabled={actionState !== null}
                    className="rounded-xl border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-bold text-primary transition-colors hover:bg-primary/15 disabled:cursor-wait disabled:opacity-60"
                  >
                    {actionState === "host-save" ? "Saving…" : "Apply Host Placement"}
                  </button>
                </div>
                {!loading && !error && snapshot?.placements.length === 0 && (
                  <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4 text-sm text-muted-foreground">
                    No explicit host placements. This team currently resolves locally.
                  </div>
                )}
                {snapshot?.placements.map((placement) => (
                  <div key={`${placement.projectId}:${placement.hostId}`} className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
                    <div className="text-sm font-bold text-foreground">{placement.hostName ?? placement.hostSlug ?? placement.hostId}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{placement.hostAddress ?? "No host address"}</div>
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      {placement.assignmentSource} · {new Date(placement.assignedAt).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-5 rounded-xl border border-white/5 bg-white/[0.03] p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Host Roster</div>
                <div className="mt-3 space-y-2">
                  {(snapshot?.hosts ?? []).length === 0 ? (
                    <div className="text-sm text-muted-foreground">No hosts registered for this team yet.</div>
                  ) : (
                    snapshot?.hosts.map((host) => (
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
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-white/5 bg-card/20 p-6">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-foreground">Knowledge</h3>
                <span className="text-xs text-muted-foreground">
                  {(snapshot?.knowledgeDocuments.length ?? 0) + (snapshot?.knowledgeFacts.length ?? 0)}
                </span>
              </div>
              <div className="mt-4 space-y-4">
                <div className="grid gap-3">
                  <input
                    value={noteTitle}
                    onChange={(event) => setNoteTitle(event.target.value)}
                    placeholder="Decision or note title"
                    className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-foreground outline-none"
                  />
                  <input
                    value={noteSummary}
                    onChange={(event) => setNoteSummary(event.target.value)}
                    placeholder="One-line summary"
                    className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-foreground outline-none"
                  />
                  <textarea
                    value={noteBody}
                    onChange={(event) => setNoteBody(event.target.value)}
                    placeholder="Capture policy, decisions, or operator notes for this team."
                    rows={4}
                    className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-foreground outline-none"
                  />
                  <button
                    onClick={() => void saveKnowledgeNote()}
                    disabled={actionState !== null}
                    className="rounded-xl border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-bold text-primary transition-colors hover:bg-primary/15 disabled:cursor-wait disabled:opacity-60"
                  >
                    {actionState === "knowledge-save" ? "Saving…" : "Save Team Note"}
                  </button>
                </div>
                {!loading && !error && snapshot?.knowledgeDocuments.length === 0 && snapshot?.knowledgeFacts.length === 0 && (
                  <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4 text-sm text-muted-foreground">
                    No knowledge has been recorded for this team yet.
                  </div>
                )}
                {snapshot?.knowledgeDocuments.map((document) => (
                  <div key={document.id} className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-bold text-foreground">{document.title}</span>
                      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{document.kind}</span>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">{document.summary}</div>
                  </div>
                ))}
                {snapshot?.knowledgeFacts.map((fact) => (
                  <div key={fact.id} className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-foreground">{fact.statement}</span>
                      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{fact.confidence}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-white/5 bg-card/20 p-6">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-foreground">Audit Trail</h3>
                <span className="text-xs text-muted-foreground">{snapshot?.auditEvents.length ?? 0}</span>
              </div>
              <div className="mt-4 space-y-3">
                {!loading && !error && snapshot?.auditEvents.length === 0 && (
                  <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4 text-sm text-muted-foreground">
                    No audit events recorded yet for this team.
                  </div>
                )}
                {snapshot?.auditEvents.map((event) => (
                  <div key={event.id} className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-bold text-foreground">{event.summary}</span>
                      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{event.action}</span>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {event.entityType} · {new Date(event.occurredAt).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function describeScheduleWindows(policyKind: string, windows: unknown) {
  if (policyKind === "always_on") return "Runs continuously.";
  if (policyKind === "manual_only") return "Founder-driven only. The fleet will not auto-run this team.";
  if (policyKind === "burst_on_backlog") return "Paused when idle and resumes when backlog is present.";

  if (!Array.isArray(windows) || windows.length === 0) {
    return "No schedule windows recorded.";
  }

  const ranges = windows
    .map((value) => {
      if (!value || typeof value !== "object") return null;
      const record = value as { start_hour?: number; end_hour?: number; weekdays?: number[] };
      const weekdays = Array.isArray(record.weekdays)
        ? record.weekdays.map((weekday) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][weekday] ?? weekday).join(", ")
        : "Every day";
      return `${weekdays} · ${record.start_hour ?? "?"}:00-${record.end_hour ?? "?"}:00`;
    })
    .filter(Boolean);

  return ranges.join(" / ");
}

function describeTeamReconcileResult(result: FleetTeamSnapshot["reconcilePreview"]["results"][number]) {
  if (!result.action) {
    return "Already aligned with the current policy.";
  }

  const target = result.target as {
    resolution?: string;
    transport?: string;
    host_name?: string;
    host_slug?: string;
    host_address?: string;
    host_id?: string;
  } | null;
  const commandResult = result.commandResult as { message?: string } | null;
  const details = [
    `Would ${result.action} because desired ${result.desiredState} differs from observed ${result.observedState ?? "unknown"}.`,
    target?.resolution ? `resolution ${target.resolution}` : null,
    target?.transport ? `transport ${target.transport}` : null,
    target?.host_name || target?.host_slug || target?.host_address || target?.host_id
      ? `host ${target.host_name ?? target.host_slug ?? target.host_address ?? target.host_id}`
      : null,
    commandResult?.message ?? null,
  ];

  return details.filter(Boolean).join(" ");
}

function GlobalAoPanel({ info }: { info: GlobalAoInfo }) {
  const configuredProviders = info.providers.filter((provider) => provider.configured);

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

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ProjectStateTone = "failed" | "blocked" | "degraded" | "healthy" | "idle";

function getProjectState(project: FleetProject, events: StreamEvent[]) {
  if (!project.enabled) {
    return {
      tone: "idle" as const,
      label: "Held",
      summary: "Project is registered to the fleet but currently disabled by company policy.",
      action: "Review policy",
      score: 1,
    };
  }

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
          <span className={cn(
            "rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
            p.enabled
              ? "border-primary/20 bg-primary/10 text-primary"
              : "border-white/10 bg-white/5 text-muted-foreground"
          )}>
            {p.enabled ? "enabled" : "idle"}
          </span>
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
  const [viewMode, setViewMode] = useState<"stream" | "config" | "tasks" | "commits">(
    events.length > 0 || p.workflows.length > 0 ? "stream" : "config"
  );
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [taskList, setTaskList] = useState<TaskInfo[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);
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
    let cancelled = false;
    setViewMode(events.length > 0 || p.workflows.length > 0 ? "stream" : "config");
    setConfig(null);
    setTaskList([]);
    setCommits([]);
    setConfigError(null);
    setTasksError(null);
    setCommitsError(null);
    setConfigLoading(true);
    setTasksLoading(true);
    setCommitsLoading(true);

    invoke<ProjectConfig>("get_project_config", { projectRoot: p.root })
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch((error) => {
        if (!cancelled) setConfigError(String(error));
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false);
      });

    invoke<TaskInfo[]>("get_task_list", { projectRoot: p.root })
      .then((value) => {
        if (!cancelled) setTaskList(value);
      })
      .catch((error) => {
        if (!cancelled) setTasksError(String(error));
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });

    invoke<CommitInfo[]>("get_recent_commits", { projectRoot: p.root })
      .then((value) => {
        if (!cancelled) setCommits(value);
      })
      .catch((error) => {
        if (!cancelled) setCommitsError(String(error));
      })
      .finally(() => {
        if (!cancelled) setCommitsLoading(false);
      });

    return () => {
      cancelled = true;
    };
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
        {viewMode === "config" ? (
          <ConfigPanel config={config} loading={configLoading} error={configError} />
        ) : viewMode === "tasks" ? (
          <TasksPanel tasks={taskList} loading={tasksLoading} error={tasksError} />
        ) : viewMode === "commits" ? (
          <CommitsPanel commits={commits} loading={commitsLoading} error={commitsError} />
        ) :
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
                   {streamFilter.type === "all"
                     ? "Live Stream"
                     : streamFilter.type === "workflow"
                       ? streamFilter.value
                       : streamFilter.label}
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

function DetailState({
  loading,
  error,
  empty,
  emptyLabel,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyLabel: string;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
        Loading project data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-xl rounded-xl border border-chart-5/20 bg-chart-5/10 px-4 py-3 text-sm text-chart-5">
          {error}
        </div>
      </div>
    );
  }

  if (empty) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return <>{children}</>;
}

function ConfigPanel({
  config,
  loading,
  error,
}: {
  config: ProjectConfig | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <DetailState
      loading={loading}
      error={error}
      empty={!config}
      emptyLabel="No project configuration is available for this repo yet."
    >
      {config ? <ConfigView config={config} /> : null}
    </DetailState>
  );
}

function TasksPanel({
  tasks,
  loading,
  error,
}: {
  tasks: TaskInfo[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <DetailState
      loading={loading}
      error={error}
      empty={tasks.length === 0}
      emptyLabel="No AO tasks are available for this repo."
    >
      <TasksView tasks={tasks} />
    </DetailState>
  );
}

function CommitsPanel({
  commits,
  loading,
  error,
}: {
  commits: CommitInfo[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <DetailState
      loading={loading}
      error={error}
      empty={commits.length === 0}
      emptyLabel="No recent commits were found for this repo."
    >
      <CommitsView commits={commits} />
    </DetailState>
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

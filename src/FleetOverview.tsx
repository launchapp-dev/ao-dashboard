import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { FleetProject, StreamEvent, ProjectConfig } from "./types";

const STATUS_COLORS: Record<string, string> = {
  running: "#22c55e",
  stopped: "#6b7280",
  crashed: "#ef4444",
  offline: "#374151",
};

const TASK_COLORS: Record<string, string> = {
  done: "#22c55e",
  ready: "#3b82f6",
  backlog: "#6b7280",
  blocked: "#eab308",
  in_progress: "#a78bfa",
  cancelled: "#ef4444",
  on_hold: "#f97316",
};

interface Props {
  projects: FleetProject[];
  events: StreamEvent[];
}

export function FleetOverview({ projects, events }: Props) {
  const [selected, setSelected] = useState<FleetProject | null>(null);

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
      done: p.tasks!.done,
      ready: p.tasks!.ready,
      backlog: p.tasks!.backlog,
      blocked: p.tasks!.blocked,
      in_progress: p.tasks!.in_progress,
    }));

  return (
    <div style={{ height: "calc(100vh - 60px)", overflow: selected ? "hidden" : "auto", padding: selected ? 0 : 20 }}>
      {!selected ? (
        <>
          {/* Summary Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 20 }}>
            <SummaryCard label="Projects" value={projects.length} color="#3b82f6" />
            <SummaryCard label="Agents" value={`${totalAgents}/${totalPool}`} color="#22c55e" />
            <SummaryCard label="Workflows" value={totalWorkflows} color="#a78bfa" />
            <SummaryCard label="Queued" value={totalQueue} color={totalQueue > 20 ? "#eab308" : "#6b7280"} />
            <SummaryCard label="Tasks Done" value={totalDone} color="#22c55e" />
            <SummaryCard label="Total Tasks" value={totalTasks} color="#3b82f6" />
          </div>

          {/* Charts Row */}
          <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 20, marginBottom: 20 }}>
            <div style={{ background: "#111128", borderRadius: 12, padding: 16 }}>
              <h3 style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>DAEMON STATUS</h3>
              <ResponsiveContainer width="100%" height={150}>
                <PieChart>
                  <Pie data={statusData} dataKey="value" cx="50%" cy="50%" innerRadius={30} outerRadius={55}>
                    {statusData.map((d) => (
                      <Cell key={d.name} fill={STATUS_COLORS[d.name] || "#333"} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid #333", borderRadius: 6 }} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                {statusData.map((d) => (
                  <span key={d.name} style={{ fontSize: 10, color: STATUS_COLORS[d.name] }}>
                    {d.name}: {d.value}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ background: "#111128", borderRadius: 12, padding: 16 }}>
              <h3 style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>TASK DISTRIBUTION</h3>
              <ResponsiveContainer width="100%" height={170}>
                <BarChart data={taskBarData} barSize={16}>
                  <XAxis dataKey="name" tick={{ fill: "#666", fontSize: 10 }} />
                  <YAxis tick={{ fill: "#666", fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid #333", borderRadius: 6, fontSize: 12 }} />
                  <Bar dataKey="done" stackId="a" fill={TASK_COLORS.done} />
                  <Bar dataKey="ready" stackId="a" fill={TASK_COLORS.ready} />
                  <Bar dataKey="in_progress" stackId="a" fill={TASK_COLORS.in_progress} />
                  <Bar dataKey="backlog" stackId="a" fill={TASK_COLORS.backlog} />
                  <Bar dataKey="blocked" stackId="a" fill={TASK_COLORS.blocked} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Project Grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
            {projects.map((p) => (
              <ProjectCard key={p.root} project={p} events={events} onClick={() => setSelected(p)} />
            ))}
          </div>
        </>
      ) : (
        <ProjectDetail project={selected} events={events} onBack={() => setSelected(null)} />
      )}
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{ background: "#111128", borderRadius: 10, padding: "12px 16px", borderLeft: `3px solid ${color}` }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
    </div>
  );
}

function ProjectCard({ project: p, events, onClick }: { project: FleetProject; events: StreamEvent[]; onClick: () => void }) {
  const status = p.health?.status || "offline";
  const color = STATUS_COLORS[status] || "#333";
  const recentEvents = events.filter((e) => e.project === p.name).slice(-3);

  return (
    <div
      onClick={onClick}
      style={{
        background: "#111128",
        border: `1px solid ${color}40`,
        borderRadius: 10,
        padding: 14,
        cursor: "pointer",
        transition: "border-color 0.2s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = color)}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = `${color}40`)}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{p.name}</span>
        <span style={{ background: color, color: "#000", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600 }}>
          {status}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, fontSize: 11, marginBottom: 8 }}>
        <div><span style={{ color: "#666" }}>agents </span><span style={{ fontWeight: 600 }}>{p.health?.active_agents || 0}/{p.health?.pool_size || 0}</span></div>
        <div><span style={{ color: "#666" }}>queue </span><span style={{ fontWeight: 600, color: (p.health?.queued_tasks || 0) > 10 ? "#eab308" : "inherit" }}>{p.health?.queued_tasks || 0}</span></div>
        <div><span style={{ color: "#666" }}>wf </span><span style={{ fontWeight: 600, color: "#a78bfa" }}>{p.workflows.length}</span></div>
      </div>

      {/* Utilization bar */}
      <div style={{ height: 3, background: "#222", borderRadius: 2, overflow: "hidden", marginBottom: 6 }}>
        <div style={{
          width: `${p.health?.pool_utilization_percent || 0}%`,
          height: "100%",
          background: (p.health?.pool_utilization_percent || 0) > 80 ? "#22c55e" : "#3b82f6",
          transition: "width 0.5s",
        }} />
      </div>

      {/* Active workflows */}
      {p.workflows.length > 0 && (
        <div style={{ fontSize: 10, color: "#888" }}>
          {p.workflows.slice(0, 2).map((wf, i) => (
            <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#3b82f6", display: "inline-block", animation: "pulse 2s infinite" }} />
              <span style={{ color: "#a78bfa" }}>{wf.workflow_ref}</span>
              <span style={{ color: "#555" }}>→ {wf.current_phase}</span>
            </div>
          ))}
          {p.workflows.length > 2 && <div style={{ color: "#555" }}>+{p.workflows.length - 2} more</div>}
        </div>
      )}

      {/* Task summary mini bar */}
      {p.tasks && p.tasks.total > 0 && (
        <div style={{ marginTop: 6, display: "flex", height: 3, borderRadius: 2, overflow: "hidden", background: "#222" }}>
          {p.tasks.done > 0 && <div style={{ width: `${(p.tasks.done / p.tasks.total) * 100}%`, background: TASK_COLORS.done }} />}
          {p.tasks.ready > 0 && <div style={{ width: `${(p.tasks.ready / p.tasks.total) * 100}%`, background: TASK_COLORS.ready }} />}
          {p.tasks.backlog > 0 && <div style={{ width: `${(p.tasks.backlog / p.tasks.total) * 100}%`, background: TASK_COLORS.backlog }} />}
          {p.tasks.blocked > 0 && <div style={{ width: `${(p.tasks.blocked / p.tasks.total) * 100}%`, background: TASK_COLORS.blocked }} />}
        </div>
      )}

      {/* Recent events */}
      {recentEvents.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 9, maxHeight: 36, overflow: "hidden" }}>
          {recentEvents.map((e, i) => (
            <div key={i} style={{
              color: e.level === "error" ? "#ef4444" : e.level === "warn" ? "#eab308" : "#555",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: "12px",
            }}>
              {e.msg.slice(0, 40)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectDetail({ project: p, events, onBack }: { project: FleetProject; events: StreamEvent[]; onBack: () => void }) {
  const [streamFilter, setStreamFilter] = useState<{ type: "all" | "workflow" | "run"; value?: string; label?: string }>({ type: "all" });
  const [levelFilter, setLevelFilter] = useState("all");
  const [textFilter, setTextFilter] = useState("");
  const [viewMode, setViewMode] = useState<"stream" | "config">("stream");
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const projectEvents = events.filter((e) => e.project === p.name);

  useEffect(() => {
    invoke<ProjectConfig>("get_project_config", { projectRoot: p.root }).then(setConfig).catch(() => {});
  }, [p.root]);

  const workflowRefs = new Map<string, { count: number; active: boolean }>();
  p.workflows.forEach((wf) => workflowRefs.set(wf.workflow_ref, { count: 0, active: true }));
  projectEvents.forEach((e) => {
    if (e.workflow_ref) {
      const existing = workflowRefs.get(e.workflow_ref);
      workflowRefs.set(e.workflow_ref, { count: (existing?.count || 0) + 1, active: existing?.active || false });
    }
  });

  const modelNames = new Map<string, number>();
  projectEvents.forEach((e) => {
    if (e.model) modelNames.set(e.model, (modelNames.get(e.model) || 0) + 1);
  });

  const filtered = projectEvents.filter((e) => {
    if (levelFilter !== "all" && e.level !== levelFilter) return false;
    if (textFilter && !e.msg.includes(textFilter) && !e.cat.includes(textFilter)) return false;
    if (streamFilter.type === "workflow" && e.workflow_ref !== streamFilter.value) return false;
    if (streamFilter.type === "run") {
      if (e.subject_id !== streamFilter.value && e.workflow_ref !== streamFilter.value) return false;
    }
    return true;
  });

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [filtered.length, autoScroll]);

  const handleLogScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  const sidebarItem = (label: string, count: number, active: boolean, onClick: () => void, dot?: string, key?: string) => (
    <div
      key={key || label}
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11,
        background: active ? "#1a1a3e" : "transparent", color: active ? "#fff" : "#888",
      }}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot, flexShrink: 0 }} />}
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ fontSize: 9, color: "#555", flexShrink: 0 }}>{count}</span>
    </div>
  );

  return (
    <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ flexShrink: 0, padding: "12px 20px 0" }}>
        <button onClick={onBack} style={{
          background: "transparent", border: "1px solid #333", color: "#888",
          padding: "6px 14px", borderRadius: 6, cursor: "pointer", marginBottom: 12, fontSize: 12,
        }}>
          ← Back to Fleet
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{p.name}</h2>
          <span style={{
            background: STATUS_COLORS[p.health?.status || "offline"],
            color: "#000", padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600,
          }}>
            {p.health?.status || "offline"}
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 12 }}>
          <SummaryCard label="Agents" value={`${p.health?.active_agents || 0}/${p.health?.pool_size || 0}`} color="#22c55e" />
          <SummaryCard label="Queue" value={p.health?.queued_tasks || 0} color="#eab308" />
          <SummaryCard label="Workflows" value={p.workflows.length} color="#a78bfa" />
          <SummaryCard label="Tasks Done" value={p.tasks?.done || 0} color="#22c55e" />
          <SummaryCard label="Total Tasks" value={p.tasks?.total || 0} color="#3b82f6" />
        </div>

        {p.tasks && (
          <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
            {Object.entries(TASK_COLORS).map(([status, color]) => {
              const count = (p.tasks as unknown as Record<string, number>)?.[status] || 0;
              if (count === 0) return null;
              return (
                <div key={status} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color }}>{count}</span>
                  <span style={{ fontSize: 10, color: "#666" }}>{status}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, padding: "0 20px 8px", flexShrink: 0 }}>
        <button onClick={() => setViewMode("stream")} style={{
          background: viewMode === "stream" ? "#1a1a3e" : "transparent", border: "1px solid #333",
          color: viewMode === "stream" ? "#fff" : "#888", padding: "4px 12px", borderRadius: 4, cursor: "pointer", fontSize: 11,
        }}>Stream</button>
        <button onClick={() => setViewMode("config")} style={{
          background: viewMode === "config" ? "#1a1a3e" : "transparent", border: "1px solid #333",
          color: viewMode === "config" ? "#fff" : "#888", padding: "4px 12px", borderRadius: 4, cursor: "pointer", fontSize: 11,
        }}>Config</button>
      </div>

      {viewMode === "config" && config ? (
        <ConfigView config={config} />
      ) : (
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "180px minmax(0, 1fr)", gap: 10, padding: "0 20px 12px", minHeight: 0, overflow: "hidden" }}>
        <div style={{ background: "#111128", borderRadius: 10, padding: 10, overflow: "auto", minWidth: 0 }}>
          {sidebarItem("All Events", projectEvents.length, streamFilter.type === "all", () => setStreamFilter({ type: "all" }), "#3b82f6")}

          {workflowRefs.size > 0 && (
            <>
              <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, padding: "10px 8px 4px", fontWeight: 600 }}>Workflows</div>
              {[...workflowRefs].map(([ref, { count, active }]) =>
                sidebarItem(ref, count, streamFilter.type === "workflow" && streamFilter.value === ref,
                  () => setStreamFilter({ type: "workflow", value: ref }),
                  active ? "#22c55e" : "#6b7280")
              )}
            </>
          )}

          {modelNames.size > 0 && (
            <>
              <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, padding: "10px 8px 4px", fontWeight: 600 }}>Models</div>
              {[...modelNames].map(([name, count]) => (
                <div key={name} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", fontSize: 11, color: "#888" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#a78bfa", flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name.replace("kimi-code/", "")}</span>
                  <span style={{ fontSize: 9, color: "#555" }}>{count}</span>
                </div>
              ))}
            </>
          )}

          {p.workflows.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, padding: "10px 8px 4px", fontWeight: 600 }}>Active Runs</div>
              {p.workflows.map((wf) => (
                <div
                  key={wf.id}
                  onClick={() => setStreamFilter({ type: "run", value: wf.task_id !== "cron" ? wf.task_id : `schedule:${wf.workflow_ref}`, label: `${wf.workflow_ref} → ${wf.current_phase}` })}
                  style={{
                    padding: "4px 8px", fontSize: 10, cursor: "pointer", borderRadius: 4,
                    background: streamFilter.type === "run" && streamFilter.label === `${wf.workflow_ref} → ${wf.current_phase}` ? "#1a1a3e" : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#3b82f6", animation: "pulse 2s infinite" }} />
                    <span style={{ color: "#a78bfa", fontWeight: 600 }}>{wf.workflow_ref}</span>
                  </div>
                  <div style={{ color: "#555", paddingLeft: 9 }}>
                    {wf.current_phase} ({wf.phase_progress})
                    {wf.task_id !== "cron" && <span style={{ color: "#444" }}> · {wf.task_id}</span>}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={{ background: "#111128", borderRadius: 10, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderBottom: "1px solid #1a1a2e", flexShrink: 0, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "#888", fontWeight: 600 }}>
              {streamFilter.type === "all" ? "ALL" : streamFilter.type === "run" ? streamFilter.label : streamFilter.value?.toUpperCase()}
            </span>
            <span style={{ fontSize: 10, color: "#444" }}>{filtered.length} events</span>
            <div style={{ flex: 1 }} />
            <input
              placeholder="Filter..."
              value={textFilter}
              onChange={(e) => setTextFilter(e.target.value)}
              style={{
                background: "#0a0a1a", border: "1px solid #222", borderRadius: 4, color: "#ccc",
                padding: "3px 8px", fontSize: 11, width: 160, outline: "none",
              }}
            />
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              style={{
                background: "#0a0a1a", border: "1px solid #222", borderRadius: 4, color: "#ccc",
                padding: "3px 6px", fontSize: 11, outline: "none",
              }}
            >
              <option value="all">All levels</option>
              <option value="error">Error</option>
              <option value="warn">Warn</option>
              <option value="info">Info</option>
            </select>
          </div>

          <div ref={logRef} onScroll={handleLogScroll} style={{
            flex: 1, overflow: "auto", padding: "4px 12px",
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11, lineHeight: "16px",
          }}>
            {filtered.length === 0 ? (
              <div style={{ color: "#444", padding: 20, textAlign: "center" }}>No events matching filter</div>
            ) : (
              filtered.map((e, i) => (
                  <div key={i} style={{
                    display: "flex", gap: 8, padding: "1px 0",
                    color: e.level === "error" ? "#ef4444" : e.level === "warn" ? "#eab308" : "#888",
                  }}>
                    <span style={{ color: "#444", minWidth: 55, flexShrink: 0 }}>{e.ts.slice(11, 19)}</span>
                    <span style={{ color: "#555", minWidth: 90, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.cat}</span>
                    {e.workflow_ref && (
                      <span
                        onClick={() => setStreamFilter({ type: "workflow", value: e.workflow_ref! })}
                        style={{ color: "#a78bfa", flexShrink: 0, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 100 }}
                      >
                        {e.workflow_ref}
                      </span>
                    )}
                    {e.phase_id && (
                      <span style={{ color: "#38bdf8", flexShrink: 0, fontSize: 10 }}>{e.phase_id}</span>
                    )}
                    {e.model && (
                      <span style={{ color: "#666", flexShrink: 0, fontSize: 10 }}>{e.model.replace("kimi-code/", "")}</span>
                    )}
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.msg}</span>
                  </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      </div>
      )}

      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  );
}

function cronToHuman(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length < 5) return cron;
  const [min, hour] = parts;
  if (min.startsWith("*/")) return `Every ${min.slice(2)} min`;
  if (min.includes("-") && min.includes("/")) {
    const interval = min.split("/")[1];
    return `Every ${interval} min`;
  }
  if (hour.startsWith("*/")) return `Every ${hour.slice(2)} hours`;
  if (hour === "*" && min.match(/^\d+$/)) return `Hourly at :${min.padStart(2, "0")}`;
  return cron;
}

function ConfigView({ config }: { config: ProjectConfig }) {
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);

  const sectionStyle = { background: "#111128", borderRadius: 10, padding: 12 };
  const headerStyle = { fontSize: 11, color: "#555", textTransform: "uppercase" as const, letterSpacing: 0.5, marginBottom: 8, fontWeight: 600 };

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "0 20px 12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignContent: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={sectionStyle}>
          <h3 style={headerStyle}>Workflows ({config.workflows.length})</h3>
          {config.workflows.map((wf) => (
            <div key={wf.id} style={{ marginBottom: 10, padding: 8, background: "#0a0a1a", borderRadius: 6, borderLeft: "3px solid #a78bfa" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                <span style={{ fontWeight: 600, fontSize: 12, color: "#a78bfa" }}>{wf.id}</span>
                {wf.name && <span style={{ fontSize: 10, color: "#666" }}>— {wf.name}</span>}
              </div>
              {wf.description && <div style={{ fontSize: 10, color: "#555", marginBottom: 4 }}>{wf.description}</div>}
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                {wf.phases.map((pid, i) => {
                  const phase = config.phases.find((p) => p.id === pid);
                  return (
                    <span key={i} style={{
                      fontSize: 9, padding: "2px 6px", borderRadius: 3, cursor: "pointer",
                      background: phase?.mode === "command" ? "#1a2a1a" : "#1a1a2e",
                      color: phase?.mode === "command" ? "#22c55e" : "#38bdf8",
                      border: `1px solid ${phase?.mode === "command" ? "#22c55e30" : "#38bdf830"}`,
                    }} onClick={() => setExpandedPhase(expandedPhase === pid ? null : pid)}>
                      {i + 1}. {pid}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div style={sectionStyle}>
          <h3 style={headerStyle}>Schedules ({config.schedules.length})</h3>
          {config.schedules.map((s) => (
            <div key={s.id} style={{ padding: "6px 8px", marginBottom: 4, background: "#0a0a1a", borderRadius: 4, borderLeft: `3px solid ${s.enabled ? "#eab308" : "#333"}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "#eab308", fontWeight: 600, fontSize: 11 }}>{s.id}</span>
                {!s.enabled && <span style={{ fontSize: 8, color: "#ef4444", background: "#1a0a0a", padding: "1px 4px", borderRadius: 2 }}>disabled</span>}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                <span style={{ fontSize: 10, color: "#888" }}>{cronToHuman(s.cron)}</span>
                <span style={{ fontSize: 9, color: "#555", fontFamily: "'JetBrains Mono', monospace" }}>{s.cron}</span>
              </div>
              <div style={{ fontSize: 9, color: "#a78bfa", marginTop: 1 }}>→ {s.workflow_ref}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={sectionStyle}>
          <h3 style={headerStyle}>Agents ({config.agents.length})</h3>
          {config.agents.map((a) => (
            <div key={a.name} style={{
              padding: 8, marginBottom: 4, background: "#0a0a1a", borderRadius: 6, cursor: "pointer",
              borderLeft: `3px solid ${expandedAgent === a.name ? "#38bdf8" : "#333"}`,
            }} onClick={() => setExpandedAgent(expandedAgent === a.name ? null : a.name)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "#38bdf8", fontWeight: 600, fontSize: 11 }}>{a.name}</span>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <span style={{ fontSize: 9, color: "#666" }}>{a.model.replace("kimi-code/", "")}</span>
                  <span style={{ fontSize: 9, color: "#444", background: "#1a1a2e", padding: "1px 4px", borderRadius: 2 }}>{a.tool}</span>
                </div>
              </div>
              {a.mcp_servers.length > 0 && (
                <div style={{ display: "flex", gap: 3, marginTop: 3 }}>
                  {a.mcp_servers.map((s) => (
                    <span key={s} style={{ fontSize: 8, padding: "1px 4px", borderRadius: 2, background: "#1a2a1a", color: "#22c55e" }}>{s}</span>
                  ))}
                </div>
              )}
              {expandedAgent === a.name && a.system_prompt && (
                <div style={{
                  marginTop: 6, padding: 8, background: "#080818", borderRadius: 4, fontSize: 10, color: "#888",
                  fontFamily: "'JetBrains Mono', monospace", whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto", lineHeight: "14px",
                }}>
                  {a.system_prompt}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={sectionStyle}>
          <h3 style={headerStyle}>Phases ({config.phases.length})</h3>
          {config.phases.map((ph) => (
            <div key={ph.id} style={{
              padding: 6, marginBottom: 3, background: "#0a0a1a", borderRadius: 4, cursor: "pointer",
              borderLeft: `3px solid ${expandedPhase === ph.id ? (ph.mode === "command" ? "#22c55e" : "#38bdf8") : "#222"}`,
            }} onClick={() => setExpandedPhase(expandedPhase === ph.id ? null : ph.id)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: ph.mode === "command" ? "#22c55e" : "#38bdf8", fontWeight: 600, fontSize: 10 }}>{ph.id}</span>
                <span style={{ fontSize: 9, color: "#444" }}>
                  {ph.mode === "command" ? (ph.command ? `$ ${ph.command} ${ph.command_args.join(" ")}` : "cmd") : (ph.agent || "agent")}
                </span>
              </div>
              {expandedPhase === ph.id && (
                <div style={{ marginTop: 4, fontSize: 10, color: "#888" }}>
                  {ph.mode === "command" && ph.command && (
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", background: "#080818", padding: 6, borderRadius: 4, marginBottom: 4 }}>
                      <span style={{ color: "#22c55e" }}>$ {ph.command} {ph.command_args.join(" ")}</span>
                      {ph.cwd_mode && <div style={{ color: "#555", fontSize: 9 }}>cwd: {ph.cwd_mode}</div>}
                      {ph.timeout_secs && <div style={{ color: "#555", fontSize: 9 }}>timeout: {ph.timeout_secs}s</div>}
                    </div>
                  )}
                  {ph.directive && (
                    <div style={{ whiteSpace: "pre-wrap", fontFamily: "'JetBrains Mono', monospace", background: "#080818", padding: 6, borderRadius: 4, maxHeight: 150, overflow: "auto", lineHeight: "14px", fontSize: 9 }}>
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

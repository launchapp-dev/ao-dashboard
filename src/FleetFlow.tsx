import { useMemo, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import { ProjectNode } from "./ProjectNode";
import { WorkflowNode } from "./WorkflowNode";
import { PhaseNode } from "./PhaseNode";
import { ScheduleNode } from "./ScheduleNode";
import type { DaemonHealth, StreamEvent, Project, ProjectConfig } from "./types";

const nodeTypes = { project: ProjectNode, workflow: WorkflowNode, phase: PhaseNode, schedule: ScheduleNode };

const edgeDefaults = {
  style: { stroke: "#333", strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: "#444", width: 12, height: 12 },
};

function cronToHuman(cron: string): string {
  const p = cron.split(" ");
  if (p.length < 5) return cron;
  if (p[0].startsWith("*/")) return `Every ${p[0].slice(2)}m`;
  if (p[0].includes("/")) return `Every ${p[0].split("/")[1]}m`;
  if (p[1].startsWith("*/")) return `Every ${p[1].slice(2)}h`;
  if (p[1] === "*" && p[0].match(/^\d+$/)) return `Hourly :${p[0].padStart(2, "0")}`;
  return cron;
}

interface Props { health: DaemonHealth[]; events: StreamEvent[]; projects: Project[]; }

export function FleetFlow({ health, events, projects }: Props) {
  const [configs, setConfigs] = useState<Record<string, ProjectConfig>>({});
  const [selectedProject, setSelectedProject] = useState<string | null>(projects[0]?.root || null);

  useEffect(() => {
    projects.forEach((p) => {
      invoke<ProjectConfig>("get_project_config", { projectRoot: p.root })
        .then((cfg) => setConfigs((prev) => ({ ...prev, [p.root]: cfg })))
        .catch(() => {});
    });
  }, [projects]);

  useEffect(() => {
    if (!selectedProject && projects.length > 0) setSelectedProject(projects[0].root);
  }, [projects, selectedProject]);

  const activeWorkflows = useMemo(() => {
    const wfs = new Map<string, { project: string; workflowRef: string; currentPhase: string | null; model?: string }>();
    for (const e of events) {
      const wfRef = e.workflow_ref;
      if (!wfRef) continue;
      const key = `${e.project}:${wfRef}`;
      if (e.cat === "workflow.start") wfs.set(key, { project: e.project, workflowRef: wfRef, currentPhase: null });
      else if (e.cat === "phase.start") { const ex = wfs.get(key); if (ex) ex.currentPhase = e.phase_id || e.msg.split(" ")[0]; }
      else if (e.cat === "phase.complete" && e.model) { const ex = wfs.get(key); if (ex) ex.model = e.model; }
      else if (e.cat === "workflow.complete") wfs.delete(key);
    }
    return Array.from(wfs.values());
  }, [events]);

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const proj = projects.find((p) => p.root === selectedProject);
    if (!proj) return { nodes, edges };

    const h = health.find((h) => h.root === proj.root);
    const cfg = configs[proj.root];

    if (!cfg) return { nodes, edges };

    const ROW_H = 90;
    const SCHED_X = 0;
    const WF_X = 220;
    const PHASE_START_X = 460;
    const PHASE_W = 200;
    const scheduledWfIds = new Set(cfg.schedules.map((s) => s.workflow_ref));
    const scheduledWfs = cfg.workflows.filter((wf) => scheduledWfIds.has(wf.id));
    const taskWfs = cfg.workflows.filter((wf) => !scheduledWfIds.has(wf.id));

    let row = 0;

    const projId = "proj";
    const projY = -150;

    nodes.push({
      id: projId, type: "project", position: { x: WF_X, y: projY },
      data: {
        health: h || { project: proj.name, root: proj.root, status: "offline", active_agents: 0, pool_size: 0, queued_tasks: 0, daemon_pid: null, pool_utilization_percent: 0, healthy: false },
        events: events.filter((e) => e.project === proj.name).slice(-3),
      },
    });

    const addGroup = (label: string, workflows: typeof cfg.workflows, color: string) => {
      if (workflows.length === 0) return;

      const labelY = row * ROW_H;
      nodes.push({
        id: `lbl-${label}`, type: "default", position: { x: WF_X - 10, y: labelY - 18 },
        data: { label }, selectable: false, draggable: false,
        style: { background: "transparent", border: "none", color, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, padding: 0, width: "auto" },
      });

      workflows.forEach((wf) => {
        const y = row * ROW_H;
        const wfId = `wf-${wf.id}`;
        const isActive = activeWorkflows.some((aw) => aw.project === proj.name && aw.workflowRef === wf.id);
        const activePhase = activeWorkflows.find((aw) => aw.project === proj.name && aw.workflowRef === wf.id)?.currentPhase;
        const schedule = cfg.schedules.find((s) => s.workflow_ref === wf.id);

        if (schedule) {
          const schedId = `sched-${schedule.id}`;
          nodes.push({
            id: schedId, type: "schedule", position: { x: SCHED_X, y },
            data: { id: schedule.id, cron: schedule.cron, humanCron: cronToHuman(schedule.cron), enabled: schedule.enabled },
          });
          edges.push({ id: `e-s-${schedId}`, source: schedId, target: wfId, ...edgeDefaults, animated: isActive, style: { stroke: isActive ? "#eab308" : "#eab30830", strokeWidth: 1.5 } });
        }

        nodes.push({
          id: wfId, type: "workflow", position: { x: WF_X, y },
          data: {
            workflow: {
              project: proj.name, workflowRef: wf.id, currentPhase: activePhase || null,
              status: isActive ? "running" : "idle", phaseCount: wf.phases.length,
              cron: schedule?.cron, isScheduled: !!schedule,
            },
          },
        });

        edges.push({ id: `e-proj-${wfId}`, source: projId, target: wfId, ...edgeDefaults, animated: isActive });

        wf.phases.forEach((pid, pi) => {
          const phase = cfg.phases.find((p) => p.id === pid);
          const phaseId = `ph-${wf.id}-${pid}-${pi}`;
          const phaseX = PHASE_START_X + pi * PHASE_W;
          const isCurrentPhase = activePhase === pid && isActive;
          const agentCfg = phase?.agent ? cfg.agents.find((a) => a.name === phase.agent) : null;

          nodes.push({
            id: phaseId, type: "phase", position: { x: phaseX, y },
            data: {
              phase: pid, index: `${pi + 1}/${wf.phases.length}`, workflowRef: wf.id,
              mode: phase?.mode || "agent", agent: phase?.agent, command: phase?.command,
              model: agentCfg?.model, isActive: isCurrentPhase,
            },
          });

          if (pi === 0) {
            edges.push({ id: `e-${wfId}-${phaseId}`, source: wfId, target: phaseId, ...edgeDefaults, animated: isActive });
          } else {
            const prevId = `ph-${wf.id}-${wf.phases[pi - 1]}-${pi - 1}`;
            edges.push({ id: `e-c-${phaseId}`, source: prevId, target: phaseId, ...edgeDefaults, animated: isCurrentPhase });
          }
        });

        row++;
      });

      row++;
    };

    addGroup("Scheduled Workflows", scheduledWfs, "#eab308");
    addGroup("Task Pipelines", taskWfs, "#3b82f6");

    return { nodes, edges };
  }, [health, events, projects, configs, selectedProject, activeWorkflows]);

  return (
    <div className="w-full h-[calc(100vh-60px)] flex">
      <div className="w-[150px] bg-background border-r border-border p-2 overflow-auto shrink-0">
        <div className="text-[9px] text-muted-foreground/40 uppercase tracking-wide px-1.5 pb-1 font-semibold">Projects</div>
        {projects.map((p) => {
          const ph = health.find((h) => h.root === p.root);
          return (
            <div key={p.root} onClick={() => setSelectedProject(p.root)}
              className={cn("text-[10px] px-1.5 py-1 rounded cursor-pointer mb-0.5 flex items-center gap-1.5",
                selectedProject === p.root ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground"
              )}>
              <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", ph?.status === "running" ? "bg-chart-1" : "bg-muted-foreground/30")} />
              {p.name}
            </div>
          );
        })}

        {selectedProject && configs[selectedProject] && (
          <>
            <div className="text-[9px] text-muted-foreground/40 uppercase tracking-wide px-1.5 pt-3 pb-1 font-semibold">Models in Use</div>
            {(() => {
              const models = new Map<string, number>();
              const projName = projects.find((p) => p.root === selectedProject)?.name;
              events.filter((e) => e.project === projName && e.model).forEach((e) => models.set(e.model!, (models.get(e.model!) || 0) + 1));
              if (models.size === 0) {
                configs[selectedProject].agents.forEach((a) => models.set(a.model, 0));
              }
              return [...models].map(([name, count]) => (
                <div key={name} className="flex items-center gap-1.5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{name.replace("kimi-code/", "").replace("claude-", "")}</span>
                  {count > 0 && <span className="text-[9px] text-muted-foreground/30">{count}</span>}
                </div>
              ));
            })()}

            <div className="text-[9px] text-muted-foreground/40 uppercase tracking-wide px-1.5 pt-3 pb-1 font-semibold">MCP Servers</div>
            {(() => {
              const servers = new Set<string>();
              configs[selectedProject].agents.forEach((a) => a.mcp_servers.forEach((s) => servers.add(s)));
              return [...servers].map((s) => (
                <div key={s} className="px-1.5 py-0.5 text-[10px] text-chart-1 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-chart-1/50 shrink-0" />
                  {s}
                </div>
              ));
            })()}
          </>
        )}
      </div>
      <div className="flex-1">
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={edgeDefaults}
          key={selectedProject}
        >
          <Background color="#222" gap={24} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

import { useMemo, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ReactFlow, Background, Controls,
  type Node, type Edge, MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import { ProjectNode } from "./ProjectNode";
import { WorkflowNode } from "./WorkflowNode";
import { PhaseNode } from "./PhaseNode";
import { ScheduleNode } from "./ScheduleNode";
import { GroupNode } from "./GroupNode";
import { AgentNode } from "./AgentNode";
import type { DaemonHealth, StreamEvent, Project, ProjectConfig } from "./types";

const nodeTypes = {
  project: ProjectNode, workflow: WorkflowNode, phase: PhaseNode,
  schedule: ScheduleNode, group: GroupNode, agent: AgentNode,
};

const edge = (id: string, source: string, target: string, animated = false, color = "#333"): Edge => ({
  id, source, target, animated,
  style: { stroke: color, strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: color === "#333" ? "#444" : color, width: 10, height: 10 },
});

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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["sched", "pipe"]));

  const toggleGroup = (group: string) => {
    setExpandedGroups((prev) => { const n = new Set(prev); n.has(group) ? n.delete(group) : n.add(group); return n; });
  };

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
    const wfs = new Map<string, { project: string; workflowRef: string; currentPhase: string | null }>();
    for (const e of events) {
      const wfRef = e.workflow_ref;
      if (!wfRef) continue;
      const key = `${e.project}:${wfRef}`;
      if (e.cat === "workflow.start") wfs.set(key, { project: e.project, workflowRef: wfRef, currentPhase: null });
      else if (e.cat === "phase.start") { const ex = wfs.get(key); if (ex) ex.currentPhase = e.phase_id || e.msg.split(" ")[0]; }
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

    const ROW = 85;
    const COL_PROJECT = 0;
    const COL_GROUP = 280;
    const COL_SCHED = 500;
    const COL_WF = 700;
    const COL_PHASE = 930;
    const PHASE_W = 195;

    const scheduledWfIds = new Set(cfg.schedules.map((s) => s.workflow_ref));
    const scheduledWfs = cfg.workflows.filter((wf) => scheduledWfIds.has(wf.id));
    const taskWfs = cfg.workflows.filter((wf) => !scheduledWfIds.has(wf.id));

    const isSched = expandedGroups.has("sched");
    const isPipe = expandedGroups.has("pipe");
    const isAgent = expandedGroups.has("agent");

    const schedRows = isSched ? scheduledWfs.length : 0;
    const pipeRows = isPipe ? taskWfs.length : 0;
    const agentRows = isAgent ? cfg.agents.length : 0;

    let y = 0;

    const schedGroupY = y;
    y += (schedRows > 0 ? schedRows * ROW : ROW) + ROW * 0.5;
    const pipeGroupY = y;
    y += (pipeRows > 0 ? pipeRows * ROW : ROW) + ROW * 0.5;
    const agentGroupY = y;

    const totalHeight = agentGroupY + (agentRows > 0 ? agentRows * ROW : ROW);
    const projY = totalHeight / 2 - ROW / 2;

    nodes.push({
      id: "proj", type: "project", position: { x: COL_PROJECT, y: projY },
      data: {
        health: h || { project: proj.name, root: proj.root, status: "offline", active_agents: 0, pool_size: 0, queued_tasks: 0, daemon_pid: null, pool_utilization_percent: 0, healthy: false },
        events: events.filter((e) => e.project === proj.name).slice(-3),
      },
    });

    const schedCenterY = schedGroupY + (schedRows > 0 ? (schedRows * ROW) / 2 : 0) - 20;
    const pipeCenterY = pipeGroupY + (pipeRows > 0 ? (pipeRows * ROW) / 2 : 0) - 20;
    const agentCenterY = agentGroupY + (agentRows > 0 ? (agentRows * ROW) / 2 : 0) - 20;

    nodes.push({ id: "g-sched", type: "group", position: { x: COL_GROUP, y: schedCenterY },
      data: { label: "Schedules", count: cfg.schedules.length, color: "#eab308", icon: "⏱", expanded: isSched, onClick: () => toggleGroup("sched") } });
    nodes.push({ id: "g-pipe", type: "group", position: { x: COL_GROUP, y: pipeCenterY },
      data: { label: "Pipelines", count: taskWfs.length, color: "#3b82f6", icon: "⚡", expanded: isPipe, onClick: () => toggleGroup("pipe") } });
    nodes.push({ id: "g-agent", type: "group", position: { x: COL_GROUP, y: agentCenterY },
      data: { label: "Agents", count: cfg.agents.length, color: "#a78bfa", icon: "🤖", expanded: isAgent, onClick: () => toggleGroup("agent") } });

    edges.push(edge("e-proj-sched", "proj", "g-sched", false, "#eab30860"));
    edges.push(edge("e-proj-pipe", "proj", "g-pipe", false, "#3b82f660"));
    edges.push(edge("e-proj-agent", "proj", "g-agent", false, "#a78bfa60"));

    if (isSched) {
      scheduledWfs.forEach((wf, i) => {
        const wy = schedGroupY + i * ROW;
        const wfId = `wf-${wf.id}`;
        const isActive = activeWorkflows.some((aw) => aw.project === proj.name && aw.workflowRef === wf.id);
        const activePhase = activeWorkflows.find((aw) => aw.project === proj.name && aw.workflowRef === wf.id)?.currentPhase;
        const schedule = cfg.schedules.find((s) => s.workflow_ref === wf.id);

        if (schedule) {
          const schedId = `sched-${schedule.id}`;
          nodes.push({ id: schedId, type: "schedule", position: { x: COL_SCHED, y: wy },
            data: { id: schedule.id, cron: schedule.cron, humanCron: cronToHuman(schedule.cron), enabled: schedule.enabled } });
          edges.push(edge(`e-gs-${schedId}`, "g-sched", schedId, false, "#eab30840"));
          edges.push(edge(`e-s-${schedId}`, schedId, wfId, isActive, isActive ? "#eab308" : "#eab30830"));
        }

        nodes.push({ id: wfId, type: "workflow", position: { x: COL_WF, y: wy },
          data: { workflow: { project: proj.name, workflowRef: wf.id, currentPhase: activePhase || null, status: isActive ? "running" : "idle", phaseCount: wf.phases.length, cron: schedule?.cron, isScheduled: true } } });

        wf.phases.forEach((pid, pi) => {
          const phase = cfg.phases.find((p) => p.id === pid);
          const phaseId = `ph-${wf.id}-${pid}-${pi}`;
          const agentCfg = phase?.agent ? cfg.agents.find((a) => a.name === phase.agent) : null;
          const isCurrentPhase = activePhase === pid && isActive;
          nodes.push({ id: phaseId, type: "phase", position: { x: COL_PHASE + pi * PHASE_W, y: wy },
            data: { phase: pid, index: `${pi + 1}/${wf.phases.length}`, workflowRef: wf.id, mode: phase?.mode || "agent", agent: phase?.agent, command: phase?.command, model: agentCfg?.model, isActive: isCurrentPhase } });
          if (pi === 0) edges.push(edge(`e-${wfId}-${phaseId}`, wfId, phaseId, isActive));
          else edges.push(edge(`e-c-${phaseId}`, `ph-${wf.id}-${wf.phases[pi - 1]}-${pi - 1}`, phaseId, isCurrentPhase));
        });
      });
    }

    if (isPipe) {
      taskWfs.forEach((wf, i) => {
        const wy = pipeGroupY + i * ROW;
        const wfId = `wf-${wf.id}`;
        const isActive = activeWorkflows.some((aw) => aw.project === proj.name && aw.workflowRef === wf.id);
        const activePhase = activeWorkflows.find((aw) => aw.project === proj.name && aw.workflowRef === wf.id)?.currentPhase;

        nodes.push({ id: wfId, type: "workflow", position: { x: COL_WF, y: wy },
          data: { workflow: { project: proj.name, workflowRef: wf.id, currentPhase: activePhase || null, status: isActive ? "running" : "idle", phaseCount: wf.phases.length, isScheduled: false } } });
        edges.push(edge(`e-gp-${wfId}`, "g-pipe", wfId, isActive, isActive ? "#3b82f6" : "#3b82f630"));

        wf.phases.forEach((pid, pi) => {
          const phase = cfg.phases.find((p) => p.id === pid);
          const phaseId = `ph-${wf.id}-${pid}-${pi}`;
          const agentCfg = phase?.agent ? cfg.agents.find((a) => a.name === phase.agent) : null;
          const isCurrentPhase = activePhase === pid && isActive;
          nodes.push({ id: phaseId, type: "phase", position: { x: COL_PHASE + pi * PHASE_W, y: wy },
            data: { phase: pid, index: `${pi + 1}/${wf.phases.length}`, workflowRef: wf.id, mode: phase?.mode || "agent", agent: phase?.agent, command: phase?.command, model: agentCfg?.model, isActive: isCurrentPhase } });
          if (pi === 0) edges.push(edge(`e-${wfId}-${phaseId}`, wfId, phaseId, isActive));
          else edges.push(edge(`e-c-${phaseId}`, `ph-${wf.id}-${wf.phases[pi - 1]}-${pi - 1}`, phaseId, isCurrentPhase));
        });
      });
    }

    if (isAgent) {
      const agentPhaseMap = new Map<string, string[]>();
      cfg.phases.forEach((ph) => { if (ph.agent) { const l = agentPhaseMap.get(ph.agent) || []; l.push(ph.id); agentPhaseMap.set(ph.agent, l); } });

      cfg.agents.forEach((a, i) => {
        const wy = agentGroupY + i * ROW;
        const agentId = `agent-${a.name}`;
        nodes.push({ id: agentId, type: "agent", position: { x: COL_SCHED, y: wy },
          data: { name: a.name, model: a.model, tool: a.tool, mcp_servers: a.mcp_servers, usedIn: agentPhaseMap.get(a.name) || [] } });
        edges.push(edge(`e-ga-${agentId}`, "g-agent", agentId, false, "#a78bfa30"));
      });
    }

    return { nodes, edges };
  }, [health, events, projects, configs, selectedProject, activeWorkflows, expandedGroups]);

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
      </div>
      <div className="flex-1">
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
          key={selectedProject}
        >
          <Background color="#222" gap={24} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

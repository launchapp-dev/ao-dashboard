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
import { McpNode } from "./McpNode";
import type { DaemonHealth, StreamEvent, Project, ProjectConfig } from "./types";

const nodeTypes = {
  project: ProjectNode, workflow: WorkflowNode, phase: PhaseNode,
  schedule: ScheduleNode, group: GroupNode, agent: AgentNode, mcp: McpNode,
};

const e = (id: string, src: string, tgt: string, anim = false, color = "#333"): Edge => ({
  id, source: src, target: tgt, animated: anim,
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

  const toggleGroup = (g: string) => {
    setExpandedGroups((prev) => { const n = new Set(prev); n.has(g) ? n.delete(g) : n.add(g); return n; });
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
    for (const ev of events) {
      const wfRef = ev.workflow_ref;
      if (!wfRef) continue;
      const key = `${ev.project}:${wfRef}`;
      if (ev.cat === "workflow.start") wfs.set(key, { project: ev.project, workflowRef: wfRef, currentPhase: null });
      else if (ev.cat === "phase.start") { const ex = wfs.get(key); if (ex) ex.currentPhase = ev.phase_id || ev.msg.split(" ")[0]; }
      else if (ev.cat === "workflow.complete") wfs.delete(key);
    }
    return Array.from(wfs.values());
  }, [events]);

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const proj = projects.find((p) => p.root === selectedProject);
    if (!proj) return { nodes, edges };

    const h = health.find((hh) => hh.root === proj.root);
    const cfg = configs[proj.root];
    if (!cfg) return { nodes, edges };

    const ROW = 85;
    const isSched = expandedGroups.has("sched");
    const isPipe = expandedGroups.has("pipe");
    const isAgent = expandedGroups.has("agent");
    const isMcp = expandedGroups.has("mcp");

    const scheduledWfIds = new Set(cfg.schedules.map((s) => s.workflow_ref));
    const scheduledWfs = cfg.workflows.filter((wf) => scheduledWfIds.has(wf.id));
    const taskWfs = cfg.workflows.filter((wf) => !scheduledWfIds.has(wf.id));

    const mcpServers = new Map<string, string[]>();
    cfg.agents.forEach((a) => a.mcp_servers.forEach((s) => {
      const list = mcpServers.get(s) || [];
      list.push(a.name);
      mcpServers.set(s, list);
    }));

    const agentPhaseMap = new Map<string, string[]>();
    cfg.phases.forEach((ph) => { if (ph.agent) { const l = agentPhaseMap.get(ph.agent) || []; l.push(ph.id); agentPhaseMap.set(ph.agent, l); } });

    // Layout columns (left to right)
    const COL_MCP = -500;
    const COL_MCP_GROUP = -300;
    const COL_AGENT = -500;
    const COL_AGENT_GROUP = -300;
    const COL_PROJECT = 0;
    const COL_SCHED_GROUP = 280;
    const COL_PIPE_GROUP = 280;
    const COL_SCHED = 480;
    const COL_WF = 680;
    const COL_PHASE = 910;
    const PHASE_W = 195;

    // Calculate vertical positions
    const mcpRows = isMcp ? mcpServers.size : 0;
    const agentRows = isAgent ? cfg.agents.length : 0;
    const schedRows = isSched ? scheduledWfs.length : 0;
    const pipeRows = isPipe ? taskWfs.length : 0;

    // Right side: schedules then pipelines
    let rightY = 0;
    const schedStartY = rightY;
    rightY += (schedRows > 0 ? schedRows * ROW : ROW) + ROW * 0.5;
    const pipeStartY = rightY;
    rightY += (pipeRows > 0 ? pipeRows * ROW : ROW);
    const rightTotalH = rightY;

    // Left side: MCP then agents
    let leftY = 0;
    const mcpStartY = leftY;
    leftY += (mcpRows > 0 ? mcpRows * ROW : ROW) + ROW * 0.5;
    const agentStartY = leftY;
    leftY += (agentRows > 0 ? agentRows * ROW : ROW);

    const totalH = Math.max(rightTotalH, leftY);
    const projY = totalH / 2 - ROW / 2;

    // PROJECT NODE
    nodes.push({
      id: "proj", type: "project", position: { x: COL_PROJECT, y: projY },
      data: {
        health: h || { project: proj.name, root: proj.root, status: "offline", active_agents: 0, pool_size: 0, queued_tasks: 0, daemon_pid: null, pool_utilization_percent: 0, healthy: false },
        events: events.filter((ev) => ev.project === proj.name).slice(-3),
      },
    });

    // GROUP NODES
    const centerY = (startY: number, rows: number) => startY + (rows > 0 ? (rows * ROW) / 2 : 0) - 20;

    nodes.push({ id: "g-mcp", type: "group", position: { x: COL_MCP_GROUP, y: centerY(mcpStartY, mcpRows) },
      data: { label: "MCP Servers", count: mcpServers.size, color: "#22c55e", icon: "🔌", expanded: isMcp, onClick: () => toggleGroup("mcp"), side: "left" } });
    nodes.push({ id: "g-agent", type: "group", position: { x: COL_AGENT_GROUP, y: centerY(agentStartY, agentRows) },
      data: { label: "Agents", count: cfg.agents.length, color: "#a78bfa", icon: "🤖", expanded: isAgent, onClick: () => toggleGroup("agent"), side: "left" } });
    nodes.push({ id: "g-sched", type: "group", position: { x: COL_SCHED_GROUP, y: centerY(schedStartY, schedRows) },
      data: { label: "Schedules", count: cfg.schedules.length, color: "#eab308", icon: "⏱", expanded: isSched, onClick: () => toggleGroup("sched") } });
    nodes.push({ id: "g-pipe", type: "group", position: { x: COL_PIPE_GROUP, y: centerY(pipeStartY, pipeRows) },
      data: { label: "Pipelines", count: taskWfs.length, color: "#3b82f6", icon: "⚡", expanded: isPipe, onClick: () => toggleGroup("pipe") } });

    // Edges from project to groups
    edges.push(e("ep-mcp", "g-mcp", "proj", false, "#22c55e40"));
    edges.push(e("ep-agent", "g-agent", "proj", false, "#a78bfa40"));
    edges.push(e("ep-sched", "proj", "g-sched", false, "#eab30840"));
    edges.push(e("ep-pipe", "proj", "g-pipe", false, "#3b82f640"));

    // MCP SERVERS
    if (isMcp) {
      [...mcpServers].forEach(([name, usedBy], i) => {
        const y = mcpStartY + i * ROW;
        const id = `mcp-${name}`;
        nodes.push({ id, type: "mcp", position: { x: COL_MCP, y }, data: { name, usedBy } });
        edges.push(e(`eg-${id}`, "g-mcp", id, false, "#22c55e30"));
      });
    }

    // AGENTS
    if (isAgent) {
      cfg.agents.forEach((a, i) => {
        const y = agentStartY + i * ROW;
        const id = `agent-${a.name}`;
        nodes.push({ id, type: "agent", position: { x: COL_AGENT, y },
          data: { name: a.name, model: a.model, tool: a.tool, mcp_servers: a.mcp_servers, usedIn: agentPhaseMap.get(a.name) || [], system_prompt: a.system_prompt } });
        edges.push(e(`eg-${id}`, "g-agent", id, false, "#a78bfa30"));

      });
    }

    // Helper to render workflow chain
    const renderWf = (wf: typeof cfg.workflows[0], y: number, groupId: string, groupColor: string) => {
      const wfId = `wf-${wf.id}`;
      const isActive = activeWorkflows.some((aw) => aw.project === proj.name && aw.workflowRef === wf.id);
      const activePhase = activeWorkflows.find((aw) => aw.project === proj.name && aw.workflowRef === wf.id)?.currentPhase;
      const schedule = cfg.schedules.find((s) => s.workflow_ref === wf.id);

      if (schedule) {
        const schedId = `sched-${schedule.id}`;
        nodes.push({ id: schedId, type: "schedule", position: { x: COL_SCHED, y },
          data: { id: schedule.id, cron: schedule.cron, humanCron: cronToHuman(schedule.cron), enabled: schedule.enabled, workflow_ref: schedule.workflow_ref } });
        edges.push(e(`egs-${schedId}`, groupId, schedId, false, `${groupColor}40`));
        edges.push(e(`es-${schedId}`, schedId, wfId, isActive, isActive ? groupColor : `${groupColor}30`));
      } else {
        edges.push(e(`egp-${wfId}`, groupId, wfId, isActive, isActive ? groupColor : `${groupColor}30`));
      }

      nodes.push({ id: wfId, type: "workflow", position: { x: COL_WF, y },
        data: { workflow: { project: proj.name, workflowRef: wf.id, currentPhase: activePhase || null, status: isActive ? "running" : "idle", phaseCount: wf.phases.length, cron: schedule?.cron, isScheduled: !!schedule, name: wf.name, description: wf.description, phases: wf.phases } } });

      wf.phases.forEach((pid, pi) => {
        const phase = cfg.phases.find((p) => p.id === pid);
        const phaseId = `ph-${wf.id}-${pid}-${pi}`;
        const agentCfg = phase?.agent ? cfg.agents.find((a) => a.name === phase.agent) : null;
        const isCurrentPhase = activePhase === pid && isActive;

        nodes.push({ id: phaseId, type: "phase", position: { x: COL_PHASE + pi * PHASE_W, y },
          data: { phase: pid, index: `${pi + 1}/${wf.phases.length}`, workflowRef: wf.id, mode: phase?.mode || "agent", agent: phase?.agent, command: phase?.command, command_args: phase?.command_args, directive: phase?.directive, model: agentCfg?.model, isActive: isCurrentPhase, timeout_secs: phase?.timeout_secs, cwd_mode: phase?.cwd_mode } });

        if (pi === 0) edges.push(e(`e-${wfId}-${phaseId}`, wfId, phaseId, isActive));
        else edges.push(e(`ec-${phaseId}`, `ph-${wf.id}-${wf.phases[pi - 1]}-${pi - 1}`, phaseId, isCurrentPhase));

      });
    };

    // SCHEDULED WORKFLOWS
    if (isSched) {
      scheduledWfs.forEach((wf, i) => renderWf(wf, schedStartY + i * ROW, "g-sched", "#eab308"));
    }

    // TASK PIPELINES
    if (isPipe) {
      taskWfs.forEach((wf, i) => renderWf(wf, pipeStartY + i * ROW, "g-pipe", "#3b82f6"));
    }

    return { nodes, edges };
  }, [health, events, projects, configs, selectedProject, activeWorkflows, expandedGroups]);

  return (
    <div className="w-full h-[calc(100vh-60px)] flex">
      <div className="w-[150px] bg-background border-r border-border p-2 overflow-auto shrink-0">
        <div className="text-[9px] text-muted-foreground/40 uppercase tracking-wide px-1.5 pb-1 font-semibold">Projects</div>
        {projects.map((p) => {
          const ph = health.find((hh) => hh.root === p.root);
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

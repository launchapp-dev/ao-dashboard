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

const FLOW_COLORS = {
  active: "#6d83a6",
  muted: "#465063",
  border: "#2f3745",
};

const e = (id: string, src: string, tgt: string, anim = false, color = FLOW_COLORS.muted): Edge => ({
  id, source: src, target: tgt, animated: anim, type: "smoothstep",
  style: { stroke: color, strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color, width: 10, height: 10 },
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
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  const toggleGroup = (g: string) => {
    setExpandedGroups((prev) => { const n = new Set(prev); n.has(g) ? n.delete(g) : n.add(g); return n; });
  };

  const toggleNode = (id: string) => {
    setExpandedNodes((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  useEffect(() => {
    if (!selectedProject || configs[selectedProject]) return;
    invoke<ProjectConfig>("get_project_config", { projectRoot: selectedProject })
      .then((cfg) => setConfigs((prev) => ({ ...prev, [selectedProject]: cfg })))
      .catch(() => {});
  }, [configs, selectedProject]);

  useEffect(() => {
    if (!selectedProject && projects.length > 0) setSelectedProject(projects[0].root);
  }, [projects, selectedProject]);

  const activeWorkflows = useMemo(() => {
    const wfs = new Map<string, { projectRoot: string; workflowRef: string; currentPhase: string | null }>();
    for (const ev of events) {
      const wfRef = ev.workflow_ref;
      if (!wfRef) continue;
      const projectRoot = ev.project_root;
      if (!projectRoot) continue;
      const key = `${projectRoot}:${wfRef}`;
      if (ev.cat === "workflow.start") wfs.set(key, { projectRoot, workflowRef: wfRef, currentPhase: null });
      else if (ev.cat === "phase.start") { const ex = wfs.get(key); if (ex) ex.currentPhase = ev.phase_id || ev.msg.split(" ")[0]; }
      else if (ev.cat === "workflow.complete") wfs.delete(key);
    }
    return Array.from(wfs.values());
  }, [events]);

  const healthByRoot = useMemo(
    () => new Map(health.map((entry) => [entry.root, entry])),
    [health],
  );

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const proj = projects.find((p) => p.root === selectedProject);
    if (!proj) return { nodes, edges };

    const h = healthByRoot.get(proj.root);
    const cfg = configs[proj.root];
    if (!cfg) return { nodes, edges };

    const ROW = 130;
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

    // Columns (left to right)
    const COL_MCP = -600;
    const COL_MCP_GROUP = -350;
    const COL_AGENT = -600;
    const COL_AGENT_GROUP = -350;
    const COL_PROJECT = 0;
    const COL_SCHED_GROUP = 350;
    const COL_PIPE_GROUP = 350;
    const COL_SCHED = 580;
    const COL_WF = 800;
    const COL_PHASE = 1050;
    const PHASE_W = 210;
    const GAP = ROW * 1.2;
    const EXPANDED_ROW = 280;

    const rowH = (nodeId: string) => {
      if (expandedNodes.has(nodeId)) return EXPANDED_ROW;
      const wfId = nodeId.startsWith("wf-") ? nodeId.replace("wf-", "") : null;
      if (wfId) {
        const wf = cfg.workflows.find((w) => w.id === wfId);
        if (wf?.phases.some((pid, pi) => expandedNodes.has(`ph-${wfId}-${pid}-${pi}`))) return EXPANDED_ROW;
      }
      return ROW;
    };

    // Build cumulative Y positions per group, accounting for expanded nodes
    const mcpIds = isMcp ? [...mcpServers.keys()].map((n) => `mcp-${n}`) : [];
    const agentIds = isAgent ? cfg.agents.map((a) => `agent-${a.name}`) : [];
    const schedWfIds = isSched ? scheduledWfs.map((wf) => `wf-${wf.id}`) : [];
    const pipeWfIds = isPipe ? taskWfs.map((wf) => `wf-${wf.id}`) : [];

    const cumY = (ids: string[]) => {
      const positions: number[] = [];
      let y = 0;
      for (const id of ids) {
        positions.push(y);
        y += rowH(id);
      }
      return { positions, totalH: ids.length > 0 ? y : ROW };
    };

    const mcpLayout = cumY(mcpIds);
    const agentLayout = cumY(agentIds);
    const schedLayout = cumY(schedWfIds);
    const pipeLayout = cumY(pipeWfIds);

    const leftH = mcpLayout.totalH + GAP + agentLayout.totalH;
    const rightH = schedLayout.totalH + GAP + pipeLayout.totalH;
    const totalH = Math.max(leftH, rightH);
    const mid = totalH / 2;

    const leftOffset = mid - leftH / 2;
    const rightOffset = mid - rightH / 2;

    const mcpStartY = leftOffset;
    const agentStartY = leftOffset + mcpLayout.totalH + GAP;
    const schedStartY = rightOffset;
    const pipeStartY = rightOffset + schedLayout.totalH + GAP;

    const projY = mid - ROW / 2;

    // PROJECT NODE
    nodes.push({
      id: "proj", type: "project", position: { x: COL_PROJECT, y: projY },
      data: {
        health: h || { project: proj.name, root: proj.root, status: "offline", active_agents: 0, pool_size: 0, queued_tasks: 0, daemon_pid: null, pool_utilization_percent: 0, healthy: false },
        events: events.filter((ev) => ev.project_root === proj.root).slice(-3),
      },
    });

    // Group hub Y = center of its children's total height
    const hubY = (startY: number, layout: { totalH: number }) => startY + layout.totalH / 2 - ROW / 2;

    nodes.push({ id: "g-mcp", type: "group", position: { x: COL_MCP_GROUP, y: hubY(mcpStartY, mcpLayout) },
      data: { label: "MCP Servers", count: mcpServers.size, color: FLOW_COLORS.border, icon: "🔌", expanded: isMcp, onClick: () => toggleGroup("mcp") } });
    nodes.push({ id: "g-agent", type: "group", position: { x: COL_AGENT_GROUP, y: hubY(agentStartY, agentLayout) },
      data: { label: "Agents", count: cfg.agents.length, color: FLOW_COLORS.border, icon: "🤖", expanded: isAgent, onClick: () => toggleGroup("agent") } });
    nodes.push({ id: "g-sched", type: "group", position: { x: COL_SCHED_GROUP, y: hubY(schedStartY, schedLayout) },
      data: { label: "Schedules", count: cfg.schedules.length, color: FLOW_COLORS.border, icon: "⏱", expanded: isSched, onClick: () => toggleGroup("sched") } });
    nodes.push({ id: "g-pipe", type: "group", position: { x: COL_PIPE_GROUP, y: hubY(pipeStartY, pipeLayout) },
      data: { label: "Pipelines", count: taskWfs.length, color: FLOW_COLORS.border, icon: "⚡", expanded: isPipe, onClick: () => toggleGroup("pipe") } });

    // Edges from project to groups
    edges.push(e("ep-mcp", "g-mcp", "proj", false, FLOW_COLORS.border));
    edges.push(e("ep-agent", "g-agent", "proj", false, FLOW_COLORS.border));
    edges.push(e("ep-sched", "proj", "g-sched", false, FLOW_COLORS.border));
    edges.push(e("ep-pipe", "proj", "g-pipe", false, FLOW_COLORS.border));

    // MCP SERVERS
    if (isMcp) {
      [...mcpServers].forEach(([name, usedBy], i) => {
        const y = mcpStartY + mcpLayout.positions[i];
        const id = `mcp-${name}`;
        nodes.push({ id, type: "mcp", position: { x: COL_MCP, y }, data: { name, usedBy, expanded: expandedNodes.has(id), onToggle: () => toggleNode(id) } });
        edges.push(e(`eg-${id}`, id, "g-mcp", false, FLOW_COLORS.border));
      });
    }

    // AGENTS
    if (isAgent) {
      cfg.agents.forEach((a, i) => {
        const y = agentStartY + agentLayout.positions[i];
        const id = `agent-${a.name}`;
        nodes.push({ id, type: "agent", position: { x: COL_AGENT, y },
          data: { name: a.name, model: a.model, tool: a.tool, mcp_servers: a.mcp_servers, usedIn: agentPhaseMap.get(a.name) || [], system_prompt: a.system_prompt, expanded: expandedNodes.has(id), onToggle: () => toggleNode(id) } });
        edges.push(e(`eg-${id}`, id, "g-agent", false, FLOW_COLORS.border));
      });
    }

    // Helper to render workflow chain
    const renderWf = (wf: typeof cfg.workflows[0], y: number, groupId: string) => {
      const wfId = `wf-${wf.id}`;
      const isActive = activeWorkflows.some((aw) => aw.projectRoot === proj.root && aw.workflowRef === wf.id);
      const activePhase = activeWorkflows.find((aw) => aw.projectRoot === proj.root && aw.workflowRef === wf.id)?.currentPhase;
      const schedule = cfg.schedules.find((s) => s.workflow_ref === wf.id);
      const edgeColor = isActive ? FLOW_COLORS.active : FLOW_COLORS.border;

      if (schedule) {
        const schedId = `sched-${schedule.id}`;
        nodes.push({ id: schedId, type: "schedule", position: { x: COL_SCHED, y },
          data: { id: schedule.id, cron: schedule.cron, humanCron: cronToHuman(schedule.cron), enabled: schedule.enabled, workflow_ref: schedule.workflow_ref } });
        edges.push(e(`egs-${schedId}`, groupId, schedId, false, FLOW_COLORS.border));
        edges.push(e(`es-${schedId}`, schedId, wfId, isActive, edgeColor));
      } else {
        edges.push(e(`egp-${wfId}`, groupId, wfId, isActive, edgeColor));
      }

      nodes.push({ id: wfId, type: "workflow", position: { x: COL_WF, y },
        data: { workflow: { project: proj.name, workflowRef: wf.id, currentPhase: activePhase || null, status: isActive ? "running" : "idle", phaseCount: wf.phases.length, cron: schedule?.cron, isScheduled: !!schedule, name: wf.name, description: wf.description, phases: wf.phases }, expanded: expandedNodes.has(wfId), onToggle: () => toggleNode(wfId) } });

      wf.phases.forEach((pid, pi) => {
        const phase = cfg.phases.find((p) => p.id === pid);
        const phaseId = `ph-${wf.id}-${pid}-${pi}`;
        const agentCfg = phase?.agent ? cfg.agents.find((a) => a.name === phase.agent) : null;
        const isCurrentPhase = activePhase === pid && isActive;

        nodes.push({ id: phaseId, type: "phase", position: { x: COL_PHASE + pi * PHASE_W, y },
          data: { phase: pid, index: `${pi + 1}/${wf.phases.length}`, workflowRef: wf.id, mode: phase?.mode || "agent", agent: phase?.agent, command: phase?.command, command_args: phase?.command_args, directive: phase?.directive, model: agentCfg?.model, isActive: isCurrentPhase, timeout_secs: phase?.timeout_secs, cwd_mode: phase?.cwd_mode, expanded: expandedNodes.has(phaseId), onToggle: () => toggleNode(phaseId) } });

        if (pi === 0) edges.push(e(`e-${wfId}-${phaseId}`, wfId, phaseId, isActive, edgeColor));
        else edges.push(e(`ec-${phaseId}`, `ph-${wf.id}-${wf.phases[pi - 1]}-${pi - 1}`, phaseId, isCurrentPhase, isCurrentPhase ? FLOW_COLORS.active : FLOW_COLORS.border));

      });
    };

    // SCHEDULED WORKFLOWS
    if (isSched) {
      scheduledWfs.forEach((wf, i) => renderWf(wf, schedStartY + schedLayout.positions[i], "g-sched"));
    }

    // TASK PIPELINES
    if (isPipe) {
      taskWfs.forEach((wf, i) => renderWf(wf, pipeStartY + pipeLayout.positions[i], "g-pipe"));
    }

    return { nodes, edges };
  }, [events, projects, configs, selectedProject, activeWorkflows, expandedGroups, expandedNodes, healthByRoot]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 p-3 sm:p-4 lg:flex-row">
      <div className="shrink-0 overflow-auto rounded-[24px] border border-border/80 bg-card/55 p-2 lg:w-[190px]">
        <div className="px-2 pb-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Projects</div>
          <div className="mt-1 text-xs text-muted-foreground">Select a workspace to center the graph.</div>
        </div>
        <div className="grid gap-1 lg:flex lg:flex-col">
          {projects.map((p) => {
            const ph = healthByRoot.get(p.root);
            return (
              <button
                key={p.root}
                type="button"
                onClick={() => setSelectedProject(p.root)}
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs transition-colors",
                  selectedProject === p.root
                    ? "border-primary/35 bg-primary/12 text-foreground"
                    : "border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-background/70 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "h-2 w-2 rounded-full shrink-0",
                    ph?.status === "crashed"
                      ? "bg-chart-5"
                      : ph?.status === "running"
                        ? "bg-chart-1"
                        : "bg-muted-foreground/30",
                  )}
                />
                <span className="truncate">{p.name}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-[26px] border border-border/80 bg-card/40">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/80 bg-black/15 px-4 py-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Topology map</div>
            <div className="mt-1 text-sm text-foreground">
              {projects.find((project) => project.root === selectedProject)?.name ?? "Select a project"} execution path from infrastructure to phase runtime.
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span className="rounded-full border border-white/8 bg-background px-2.5 py-1">Left: infrastructure</span>
            <span className="rounded-full border border-white/8 bg-background px-2.5 py-1">Center: workflow entry</span>
            <span className="rounded-full border border-white/8 bg-background px-2.5 py-1">Right: execution chain</span>
          </div>
        </div>
        <div className="h-full min-h-0">
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView
            fitViewOptions={{ padding: 0.15 }}
            proOptions={{ hideAttribution: true }}
            key={selectedProject}
          >
            <Background color="#242b36" gap={24} />
            <Controls />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}

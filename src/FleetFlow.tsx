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
import { ProjectNode } from "./ProjectNode";
import { WorkflowNode } from "./WorkflowNode";
import { PhaseNode } from "./PhaseNode";
import type { DaemonHealth, StreamEvent, Project, ProjectConfig } from "./types";

const nodeTypes = {
  project: ProjectNode,
  workflow: WorkflowNode,
  phase: PhaseNode,
};

const edgeDefaults = {
  style: { stroke: "#333", strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: "#444", width: 12, height: 12 },
};

interface Props {
  health: DaemonHealth[];
  events: StreamEvent[];
  projects: Project[];
}

export function FleetFlow({ health, events, projects }: Props) {
  const [configs, setConfigs] = useState<Record<string, ProjectConfig>>({});
  const [selectedProject, setSelectedProject] = useState<string | null>(projects[0]?.root || null);
  const [expandedWorkflows, setExpandedWorkflows] = useState<Set<string>>(new Set());

  useEffect(() => {
    projects.forEach((p) => {
      invoke<ProjectConfig>("get_project_config", { projectRoot: p.root })
        .then((cfg) => setConfigs((prev) => ({ ...prev, [p.root]: cfg })))
        .catch(() => {});
    });
  }, [projects]);

  useEffect(() => {
    if (!selectedProject && projects.length > 0) {
      setSelectedProject(projects[0].root);
    }
  }, [projects, selectedProject]);

  const activeWorkflows = useMemo(() => {
    const wfs = new Map<string, { project: string; workflowRef: string; currentPhase: string | null }>();
    for (const e of events) {
      const wfRef = e.workflow_ref;
      if (!wfRef) continue;
      const key = `${e.project}:${wfRef}`;
      if (e.cat === "workflow.start") {
        wfs.set(key, { project: e.project, workflowRef: wfRef, currentPhase: null });
      } else if (e.cat === "phase.start") {
        const existing = wfs.get(key);
        if (existing) existing.currentPhase = e.phase_id || e.msg.split(" ")[0];
      } else if (e.cat === "workflow.complete") {
        wfs.delete(key);
      }
    }
    return Array.from(wfs.values());
  }, [events]);

  const toggleWorkflow = (wfId: string) => {
    setExpandedWorkflows((prev) => {
      const next = new Set(prev);
      if (next.has(wfId)) next.delete(wfId);
      else next.add(wfId);
      return next;
    });
  };

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    const proj = projects.find((p) => p.root === selectedProject);
    if (!proj) return { nodes, edges };

    const h = health.find((h) => h.root === proj.root);
    const cfg = configs[proj.root];
    const projId = `p-${proj.root}`;

    nodes.push({
      id: projId,
      type: "project",
      position: { x: 0, y: 0 },
      data: {
        health: h || { project: proj.name, root: proj.root, status: "offline", active_agents: 0, pool_size: 0, queued_tasks: 0, daemon_pid: null, pool_utilization_percent: 0, healthy: false },
        events: events.filter((e) => e.project === proj.name).slice(-3),
      },
    });

    if (!cfg) return { nodes, edges };

    const scheduleWorkflows = new Set(cfg.schedules.map((s) => s.workflow_ref));
    let wfY = 0;
    const PHASE_H = 50;
    const WF_GAP = 20;

    cfg.workflows.forEach((wf) => {
      const wfId = `wf-${wf.id}`;
      const isActive = activeWorkflows.some((aw) => aw.project === proj.name && aw.workflowRef === wf.id);
      const activePhase = activeWorkflows.find((aw) => aw.project === proj.name && aw.workflowRef === wf.id)?.currentPhase;
      const isScheduled = scheduleWorkflows.has(wf.id);
      const schedule = cfg.schedules.find((s) => s.workflow_ref === wf.id);
      const isExpanded = expandedWorkflows.has(wf.id) || isActive;

      nodes.push({
        id: wfId,
        type: "workflow",
        position: { x: 300, y: wfY },
        data: {
          workflow: {
            project: proj.name,
            workflowRef: wf.id,
            currentPhase: activePhase || null,
            status: isActive ? "running" : "idle",
            phaseCount: wf.phases.length,
            cron: schedule?.cron,
            isScheduled,
          },
          onClick: () => toggleWorkflow(wf.id),
        },
      });

      edges.push({ id: `e-${projId}-${wfId}`, source: projId, target: wfId, ...edgeDefaults, animated: isActive });

      if (isExpanded) {
        wf.phases.forEach((pid, pi) => {
          const phase = cfg.phases.find((p) => p.id === pid);
          const phaseId = `ph-${wf.id}-${pid}-${pi}`;
          const phaseY = wfY + pi * PHASE_H;

          nodes.push({
            id: phaseId,
            type: "phase",
            position: { x: 580, y: phaseY },
            data: {
              phase: pid,
              index: `${pi + 1}/${wf.phases.length}`,
              workflowRef: wf.id,
              mode: phase?.mode || "agent",
              agent: phase?.agent,
              command: phase?.command,
              model: phase?.agent ? cfg.agents.find((a) => a.name === phase.agent)?.model : undefined,
              isActive: activePhase === pid && isActive,
            },
          });

          if (pi === 0) {
            edges.push({ id: `e-${wfId}-${phaseId}`, source: wfId, target: phaseId, ...edgeDefaults, animated: isActive });
          } else {
            const prevPhaseId = `ph-${wf.id}-${wf.phases[pi - 1]}-${pi - 1}`;
            edges.push({
              id: `e-chain-${phaseId}`,
              source: prevPhaseId,
              target: phaseId,
              ...edgeDefaults,
              animated: activePhase === pid && isActive,
            });
          }
        });

        wfY += Math.max(wf.phases.length * PHASE_H, 60) + WF_GAP;
      } else {
        wfY += 60 + WF_GAP;
      }
    });

    return { nodes, edges };
  }, [health, events, projects, configs, selectedProject, activeWorkflows, expandedWorkflows]);

  return (
    <div style={{ width: "100%", height: "calc(100vh - 60px)", display: "flex" }}>
      <div style={{ width: 140, background: "#0a0a1a", borderRight: "1px solid #1a1a2e", padding: 8, overflow: "auto", flexShrink: 0 }}>
        {projects.map((p) => {
          const h = health.find((h) => h.root === p.root);
          const statusColor = h?.status === "running" ? "#22c55e" : "#555";
          return (
            <div
              key={p.root}
              onClick={() => { setSelectedProject(p.root); setExpandedWorkflows(new Set()); }}
              style={{
                fontSize: 10, padding: "5px 6px", borderRadius: 4, cursor: "pointer", marginBottom: 2,
                display: "flex", alignItems: "center", gap: 5,
                background: selectedProject === p.root ? "#1a1a3e" : "transparent",
                color: selectedProject === p.root ? "#fff" : "#888",
              }}
            >
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
              {p.name}
            </div>
          );
        })}
      </div>
      <div style={{ flex: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.3 }}
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

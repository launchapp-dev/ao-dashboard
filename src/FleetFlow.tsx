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
  animated: true,
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
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  useEffect(() => {
    projects.forEach((p) => {
      invoke<ProjectConfig>("get_project_config", { projectRoot: p.root })
        .then((cfg) => setConfigs((prev) => ({ ...prev, [p.root]: cfg })))
        .catch(() => {});
    });
  }, [projects]);

  const activeWorkflows = useMemo(() => {
    const wfs = new Map<string, { project: string; workflowRef: string; currentPhase: string | null; status: string }>();
    for (const e of events) {
      const wfRef = e.workflow_ref;
      if (!wfRef) continue;
      const key = `${e.project}:${wfRef}`;
      if (e.cat === "workflow.start") {
        wfs.set(key, { project: e.project, workflowRef: wfRef, currentPhase: null, status: "running" });
      } else if (e.cat === "phase.start") {
        const existing = wfs.get(key);
        if (existing) existing.currentPhase = e.phase_id || e.msg.split(" ")[0];
      } else if (e.cat === "workflow.complete") {
        wfs.delete(key);
      }
    }
    return Array.from(wfs.values());
  }, [events]);

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    const visibleProjects = selectedProject
      ? projects.filter((p) => p.root === selectedProject)
      : projects;

    let yOffset = 0;

    visibleProjects.forEach((proj) => {
      const h = health.find((h) => h.root === proj.root);
      const cfg = configs[proj.root];
      const projId = `p-${proj.root}`;

      nodes.push({
        id: projId,
        type: "project",
        position: { x: 0, y: yOffset },
        data: {
          health: h || { project: proj.name, root: proj.root, status: "offline", active_agents: 0, pool_size: 0, queued_tasks: 0, daemon_pid: null, pool_utilization_percent: 0, healthy: false },
          events: events.filter((e) => e.project === proj.name).slice(-3),
        },
      });

      if (!cfg) {
        yOffset += 200;
        return;
      }

      const scheduleWorkflows = new Set(cfg.schedules.map((s) => s.workflow_ref));
      const wfY = new Map<string, number>();

      cfg.workflows.forEach((wf, wi) => {
        const wfId = `wf-${proj.root}-${wf.id}`;
        const y = yOffset + wi * 60;
        wfY.set(wf.id, y);

        const isActive = activeWorkflows.some((aw) => aw.project === proj.name && aw.workflowRef === wf.id);
        const activePhase = activeWorkflows.find((aw) => aw.project === proj.name && aw.workflowRef === wf.id)?.currentPhase;
        const isScheduled = scheduleWorkflows.has(wf.id);
        const schedule = cfg.schedules.find((s) => s.workflow_ref === wf.id);

        nodes.push({
          id: wfId,
          type: "workflow",
          position: { x: 300, y },
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
          },
        });

        edges.push({ id: `e-${projId}-${wfId}`, source: projId, target: wfId, ...edgeDefaults });

        wf.phases.forEach((pid, pi) => {
          const phase = cfg.phases.find((p) => p.id === pid);
          const phaseId = `ph-${proj.root}-${wf.id}-${pid}-${pi}`;
          const phaseY = y + pi * 45;

          const isCurrentPhase = activePhase === pid && isActive;

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
              isActive: isCurrentPhase,
            },
          });

          edges.push({ id: `e-${wfId}-${phaseId}`, source: wfId, target: phaseId, ...edgeDefaults, animated: isCurrentPhase });

          if (pi > 0) {
            const prevPhaseId = `ph-${proj.root}-${wf.id}-${wf.phases[pi - 1]}-${pi - 1}`;
            edges.push({
              id: `e-chain-${phaseId}`,
              source: prevPhaseId,
              target: phaseId,
              style: { stroke: "#222", strokeWidth: 1, strokeDasharray: "4 4" },
              markerEnd: { type: MarkerType.ArrowClosed, color: "#333", width: 8, height: 8 },
            });
          }
        });
      });

      const maxWfPhases = Math.max(...cfg.workflows.map((wf) => wf.phases.length), 1);
      yOffset += Math.max(cfg.workflows.length * 60, maxWfPhases * 45) + 80;
    });

    return { nodes, edges };
  }, [health, events, projects, configs, selectedProject, activeWorkflows]);

  return (
    <div style={{ width: "100%", height: "calc(100vh - 60px)", display: "flex" }}>
      <div style={{ width: 140, background: "#0a0a1a", borderRight: "1px solid #1a1a2e", padding: 8, overflow: "auto", flexShrink: 0 }}>
        <div
          onClick={() => setSelectedProject(null)}
          style={{
            fontSize: 10, padding: "4px 6px", borderRadius: 4, cursor: "pointer", marginBottom: 4,
            background: !selectedProject ? "#1a1a3e" : "transparent", color: !selectedProject ? "#fff" : "#888",
          }}
        >All Projects</div>
        {projects.map((p) => (
          <div
            key={p.root}
            onClick={() => setSelectedProject(p.root)}
            style={{
              fontSize: 10, padding: "4px 6px", borderRadius: 4, cursor: "pointer",
              background: selectedProject === p.root ? "#1a1a3e" : "transparent",
              color: selectedProject === p.root ? "#fff" : "#888",
            }}
          >
            {p.name}
          </div>
        ))}
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
        >
          <Background color="#222" gap={24} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

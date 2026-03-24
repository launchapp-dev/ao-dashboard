import { useMemo, useCallback } from "react";
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
import type { DaemonHealth, StreamEvent } from "./types";

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
}

interface ActiveWorkflow {
  project: string;
  workflowRef: string;
  currentPhase: string | null;
  status: "running" | "completed" | "failed";
  phaseIndex?: string;
}

function buildActiveWorkflows(events: StreamEvent[]): ActiveWorkflow[] {
  const workflows = new Map<string, ActiveWorkflow>();

  for (const e of events) {
    const wfRef = (e.meta as Record<string, unknown>)?.workflow_ref as string | undefined;
    const key = `${e.project}:${wfRef || e.cat}`;

    if (e.cat === "workflow.start" && wfRef) {
      workflows.set(key, {
        project: e.project,
        workflowRef: wfRef,
        currentPhase: null,
        status: "running",
      });
    } else if (e.cat === "phase.start" && wfRef) {
      const existing = workflows.get(key);
      if (existing) {
        const phaseMatch = e.msg.match(/^(\S+)\s*\((\d+\/\d+)\)/);
        existing.currentPhase = phaseMatch ? phaseMatch[1] : e.msg;
        existing.phaseIndex = phaseMatch ? phaseMatch[2] : undefined;
      } else {
        workflows.set(key, {
          project: e.project,
          workflowRef: wfRef,
          currentPhase: e.msg.split(" ")[0],
          status: "running",
        });
      }
    } else if (e.cat === "workflow.complete" && wfRef) {
      const existing = workflows.get(key);
      if (existing) {
        existing.status = e.level === "error" ? "failed" : "completed";
      }
    }
  }

  return Array.from(workflows.values()).filter((w) => w.status === "running");
}

export function FleetFlow({ health, events }: Props) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const activeWorkflows = buildActiveWorkflows(events);

    const projectSpacing = 320;
    const wfXOffset = 300;
    const phaseXOffset = 280;

    health.forEach((h, i) => {
      const projectY = i * projectSpacing;

      nodes.push({
        id: `p-${h.project}`,
        type: "project",
        position: { x: 50, y: projectY },
        data: {
          health: h,
          events: events.filter((e) => e.project === h.project).slice(-3),
        },
      });

      const projectWorkflows = activeWorkflows.filter(
        (w) => w.project === h.project
      );

      projectWorkflows.forEach((wf, wi) => {
        const wfId = `wf-${h.project}-${wf.workflowRef}-${wi}`;
        const wfY = projectY + wi * 80 - ((projectWorkflows.length - 1) * 40);

        nodes.push({
          id: wfId,
          type: "workflow",
          position: { x: 50 + wfXOffset, y: wfY },
          data: { workflow: wf },
        });

        edges.push({
          id: `e-${h.project}-${wfId}`,
          source: `p-${h.project}`,
          target: wfId,
          ...edgeDefaults,
        });

        if (wf.currentPhase) {
          const phaseId = `ph-${h.project}-${wf.workflowRef}-${wf.currentPhase}`;

          nodes.push({
            id: phaseId,
            type: "phase",
            position: { x: 50 + wfXOffset + phaseXOffset, y: wfY },
            data: {
              phase: wf.currentPhase,
              index: wf.phaseIndex,
              workflowRef: wf.workflowRef,
            },
          });

          edges.push({
            id: `e-${wfId}-${phaseId}`,
            source: wfId,
            target: phaseId,
            ...edgeDefaults,
          });
        }
      });
    });

    return { nodes, edges };
  }, [health, events]);

  if (health.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "calc(100vh - 60px)",
          color: "#666",
        }}
      >
        Loading fleet data...
      </div>
    );
  }

  return (
    <div style={{ width: "100vw", height: "calc(100vh - 60px)" }}>
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
  );
}

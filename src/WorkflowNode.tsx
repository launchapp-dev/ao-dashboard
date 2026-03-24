import { Handle, Position } from "@xyflow/react";

interface ActiveWorkflow {
  project: string;
  workflowRef: string;
  currentPhase: string | null;
  status: "running" | "completed" | "failed";
  phaseIndex?: string;
}

interface Props {
  data: { workflow: ActiveWorkflow };
}

export function WorkflowNode({ data }: Props) {
  const { workflow: wf } = data;

  const color =
    wf.status === "running"
      ? "#3b82f6"
      : wf.status === "failed"
        ? "#ef4444"
        : "#22c55e";

  return (
    <div
      style={{
        background: "#16162a",
        border: `1.5px solid ${color}`,
        borderRadius: 8,
        padding: "8px 14px",
        minWidth: 180,
        color: "#e0e0e0",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: color }} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: color,
            display: "inline-block",
            animation: wf.status === "running" ? "pulse 2s infinite" : "none",
          }}
        />
        <span style={{ fontWeight: 600, fontSize: 12 }}>{wf.workflowRef}</span>
      </div>

      {wf.currentPhase && (
        <div style={{ fontSize: 11, color: "#888" }}>
          phase: <span style={{ color: "#a78bfa" }}>{wf.currentPhase}</span>
          {wf.phaseIndex && (
            <span style={{ color: "#666", marginLeft: 4 }}>({wf.phaseIndex})</span>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: color }} />

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

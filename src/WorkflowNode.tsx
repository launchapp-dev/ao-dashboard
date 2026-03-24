import { Handle, Position } from "@xyflow/react";

interface Props {
  data: {
    workflow: {
      project: string;
      workflowRef: string;
      currentPhase: string | null;
      status: string;
      phaseCount?: number;
      cron?: string;
      isScheduled?: boolean;
    };
  };
}

export function WorkflowNode({ data }: Props) {
  const { workflow: wf } = data;

  const isRunning = wf.status === "running";
  const color = isRunning ? "#3b82f6" : "#555";

  return (
    <div
      style={{
        background: isRunning ? "#16162a" : "#111122",
        border: `1.5px solid ${color}`,
        borderRadius: 8,
        padding: "8px 14px",
        minWidth: 180,
        color: "#e0e0e0",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: color }} />

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        {isRunning && (
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#3b82f6", animation: "pulse 2s infinite" }} />
        )}
        {wf.isScheduled && !isRunning && (
          <span style={{ fontSize: 9, color: "#eab308" }}>⏱</span>
        )}
        <span style={{ fontWeight: 600, fontSize: 12 }}>{wf.workflowRef}</span>
        {wf.phaseCount && <span style={{ fontSize: 9, color: "#555" }}>{wf.phaseCount}p</span>}
      </div>

      {wf.currentPhase && (
        <div style={{ fontSize: 11, color: "#888" }}>
          → <span style={{ color: "#a78bfa" }}>{wf.currentPhase}</span>
        </div>
      )}

      {wf.cron && (
        <div style={{ fontSize: 9, color: "#555", fontFamily: "'JetBrains Mono', monospace" }}>{wf.cron}</div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: color }} />

      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  );
}

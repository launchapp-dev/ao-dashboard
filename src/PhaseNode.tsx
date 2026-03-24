import { Handle, Position } from "@xyflow/react";

interface Props {
  data: {
    phase: string;
    index?: string;
    workflowRef: string;
  };
}

export function PhaseNode({ data }: Props) {
  const { phase, index } = data;

  const isAgent =
    phase.includes("implementation") ||
    phase.includes("review") ||
    phase.includes("triage") ||
    phase.includes("planning") ||
    phase.includes("reconcil") ||
    phase.includes("product") ||
    phase.includes("decompose") ||
    phase.includes("smoke");

  const isCommand =
    phase.includes("push") ||
    phase.includes("create-pr") ||
    phase.includes("sync") ||
    phase.includes("force-push") ||
    phase.includes("build") ||
    phase.includes("lint");

  const color = isAgent ? "#a78bfa" : isCommand ? "#38bdf8" : "#6b7280";
  const icon = isAgent ? "agent" : isCommand ? "cmd" : "phase";

  return (
    <div
      style={{
        background: "#111122",
        border: `1px solid ${color}40`,
        borderRadius: 6,
        padding: "6px 12px",
        minWidth: 140,
        color: "#ccc",
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: color }} />

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontSize: 9,
            padding: "1px 5px",
            borderRadius: 3,
            background: `${color}20`,
            color,
            fontWeight: 600,
            textTransform: "uppercase",
          }}
        >
          {icon}
        </span>
        <span style={{ fontWeight: 500 }}>{phase}</span>
        {index && <span style={{ color: "#555" }}>({index})</span>}
      </div>

      <Handle type="source" position={Position.Right} style={{ background: color }} />
    </div>
  );
}

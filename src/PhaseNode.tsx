import { Handle, Position } from "@xyflow/react";

interface Props {
  data: {
    phase: string;
    index?: string;
    workflowRef: string;
    mode?: string;
    agent?: string;
    command?: string;
    model?: string;
    isActive?: boolean;
  };
}

export function PhaseNode({ data }: Props) {
  const { phase, index, mode, agent, command, model, isActive } = data;

  const isCommand = mode === "command";
  const color = isActive ? "#22c55e" : isCommand ? "#38bdf8" : "#a78bfa";
  const label = isCommand ? "cmd" : "agent";

  return (
    <div
      style={{
        background: isActive ? "#0a1a0a" : "#111122",
        border: `1px solid ${color}${isActive ? "" : "40"}`,
        borderRadius: 6,
        padding: "6px 10px",
        minWidth: 160,
        maxWidth: 220,
        color: "#ccc",
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: color }} />

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {isActive && <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#22c55e", animation: "pulse 2s infinite" }} />}
        <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: `${color}20`, color, fontWeight: 600, textTransform: "uppercase" }}>
          {label}
        </span>
        <span style={{ fontWeight: 500 }}>{phase}</span>
        {index && <span style={{ color: "#555" }}>({index})</span>}
      </div>

      {(agent || command || model) && (
        <div style={{ marginTop: 3, fontSize: 9, color: "#666", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {isCommand && command && <span style={{ color: "#38bdf8" }}>{command}</span>}
          {!isCommand && agent && <span style={{ color: "#a78bfa" }}>{agent}</span>}
          {model && <span style={{ color: "#555" }}> · {model.replace("kimi-code/", "")}</span>}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: color }} />
    </div>
  );
}

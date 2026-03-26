import { Handle, Position } from "@xyflow/react";
import type { DaemonHealth, StreamEvent } from "./types";

interface Props {
  data: {
    health: DaemonHealth;
    events: StreamEvent[];
  };
}

export function ProjectNode({ data }: Props) {
  const { health: h, events } = data;

  const statusColor =
    h.status === "running"
      ? h.healthy
        ? "#5d9a80"
        : "#c3893d"
      : h.status === "crashed"
        ? "#b85c5c"
        : "#5a6474";

  const utilPct = h.pool_size > 0 ? (h.active_agents / h.pool_size) * 100 : 0;

  return (
    <div
      style={{
        background: "linear-gradient(180deg, hsl(220 18% 13%), hsl(220 18% 10%))",
        border: `2px solid ${statusColor}`,
        borderRadius: 18,
        padding: 18,
        width: 270,
        maxHeight: 220,
        overflow: "hidden",
        color: "hsl(210 18% 94%)",
        fontFamily: "\"Space Grotesk\", \"Avenir Next\", sans-serif",
        boxShadow: "0 18px 36px rgba(0,0,0,0.18)",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: statusColor }} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, gap: 10 }}>
        <div>
          <div style={{ color: "hsl(215 14% 72%)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.18em", marginBottom: 6 }}>Project</div>
          <span style={{ fontWeight: 700, fontSize: 16 }}>{h.project}</span>
        </div>
        <span
          style={{
            background: `${statusColor}20`,
            color: statusColor,
            border: `1px solid ${statusColor}55`,
            padding: "4px 9px",
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
          }}
        >
          {h.status}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12 }}>
        <div>
          <div style={{ color: "hsl(215 14% 72%)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 3 }}>Agents</div>
          <span style={{ fontWeight: 700, fontSize: 14 }}>
            {h.active_agents}/{h.pool_size}
          </span>
        </div>
        <div>
          <div style={{ color: "hsl(215 14% 72%)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 3 }}>Queue</div>
          <span style={{ fontWeight: 700, fontSize: 14, color: h.queued_tasks > 10 ? "#c3893d" : "inherit" }}>
            {h.queued_tasks}
          </span>
        </div>
      </div>

      <div
        style={{
          marginTop: 8,
          height: 4,
          background: "#232a35",
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${utilPct}%`,
            height: "100%",
            background: utilPct > 80 ? "#c3893d" : utilPct > 40 ? "#6d83a6" : "#5a6474",
            transition: "width 0.5s ease",
          }}
        />
      </div>

      {events.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 11, maxHeight: 58, overflow: "hidden", borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 10 }}>
          <div style={{ color: "hsl(215 14% 72%)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6 }}>Recent signals</div>
          {events.slice(-3).map((e, i) => (
            <div
              key={i}
              style={{
                color: e.level === "error" ? "#b85c5c" : e.level === "warn" ? "#c3893d" : "#a0acbf",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                lineHeight: "16px",
              }}
            >
              {e.msg.slice(0, 48)}
            </div>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: statusColor }} />
    </div>
  );
}

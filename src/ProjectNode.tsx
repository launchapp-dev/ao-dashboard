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
        ? "#22c55e"
        : "#eab308"
      : h.status === "crashed"
        ? "#ef4444"
        : "#6b7280";

  const utilPct = h.pool_size > 0 ? (h.active_agents / h.pool_size) * 100 : 0;

  return (
    <div
      style={{
        background: "#1a1a2e",
        border: `2px solid ${statusColor}`,
        borderRadius: 12,
        padding: 16,
        width: 240,
        maxHeight: 180,
        overflow: "hidden",
        color: "#e0e0e0",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: statusColor }} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{h.project}</span>
        <span
          style={{
            background: statusColor,
            color: "#000",
            padding: "2px 8px",
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {h.status}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12 }}>
        <div>
          <span style={{ color: "#888" }}>agents </span>
          <span style={{ fontWeight: 600 }}>
            {h.active_agents}/{h.pool_size}
          </span>
        </div>
        <div>
          <span style={{ color: "#888" }}>queue </span>
          <span style={{ fontWeight: 600, color: h.queued_tasks > 10 ? "#eab308" : "inherit" }}>
            {h.queued_tasks}
          </span>
        </div>
      </div>

      <div
        style={{
          marginTop: 8,
          height: 4,
          background: "#333",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${utilPct}%`,
            height: "100%",
            background: utilPct > 80 ? "#22c55e" : utilPct > 40 ? "#3b82f6" : "#6b7280",
            transition: "width 0.5s ease",
          }}
        />
      </div>

      {events.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 10, maxHeight: 42, overflow: "hidden" }}>
          {events.slice(-3).map((e, i) => (
            <div
              key={i}
              style={{
                color: e.level === "error" ? "#ef4444" : e.level === "warn" ? "#eab308" : "#666",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                lineHeight: "14px",
              }}
            >
              {e.msg.slice(0, 35)}
            </div>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: statusColor }} />
    </div>
  );
}

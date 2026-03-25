import { Handle, Position } from "@xyflow/react";

interface Props {
  data: {
    name: string;
    model: string;
    tool: string;
    mcp_servers: string[];
    usedIn: string[];
  };
}

export function AgentNode({ data }: Props) {
  return (
    <div className="bg-card border border-primary/30 rounded-lg px-3 py-2 min-w-[160px] max-w-[220px] font-sans">
      <Handle type="target" position={Position.Left} style={{ background: "#3b82f6" }} />

      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
        <span className="font-semibold text-[11px] text-primary">{data.name}</span>
      </div>
      <div className="text-[9px] text-muted-foreground font-mono">
        {data.model.replace("kimi-code/", "")}
        <span className="text-muted-foreground/30 ml-1">({data.tool})</span>
      </div>
      {data.mcp_servers.length > 0 && (
        <div className="flex gap-1 mt-1 flex-wrap">
          {data.mcp_servers.map((s) => (
            <span key={s} className="text-[8px] px-1 py-px rounded bg-chart-1/10 text-chart-1">{s}</span>
          ))}
        </div>
      )}
      {data.usedIn.length > 0 && (
        <div className="text-[8px] text-muted-foreground/30 mt-1">
          → {data.usedIn.slice(0, 3).join(", ")}{data.usedIn.length > 3 ? ` +${data.usedIn.length - 3}` : ""}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: "#3b82f6" }} />
    </div>
  );
}

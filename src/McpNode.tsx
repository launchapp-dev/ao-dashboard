import { Handle, Position } from "@xyflow/react";

interface Props {
  data: {
    name: string;
    usedBy: string[];
  };
}

export function McpNode({ data }: Props) {
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 min-w-[120px] max-w-[180px] font-sans">
      <Handle type="target" position={Position.Left} style={{ background: "#465063" }} />
      <Handle type="source" position={Position.Right} style={{ background: "#465063" }} />

      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-muted-foreground/50 shrink-0" />
        <span className="font-semibold text-[11px] text-foreground">{data.name}</span>
      </div>
      {data.usedBy.length > 0 && (
        <div className="text-[8px] text-muted-foreground/30 mt-1">
          {data.usedBy.slice(0, 3).join(", ")}{data.usedBy.length > 3 ? ` +${data.usedBy.length - 3}` : ""}
        </div>
      )}

    </div>
  );
}

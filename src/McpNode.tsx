import { Handle, Position } from "@xyflow/react";

interface Props {
  data: {
    name: string;
    usedBy: string[];
  };
}

export function McpNode({ data }: Props) {
  return (
    <div className="min-w-[140px] max-w-[200px] rounded-[16px] border border-border bg-card px-3 py-3 font-sans">
      <Handle type="target" position={Position.Left} style={{ background: "#465063" }} />
      <Handle type="source" position={Position.Right} style={{ background: "#465063" }} />

      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-muted-foreground/50 shrink-0" />
        <span className="font-semibold text-[12px] text-foreground">{data.name}</span>
      </div>
      {data.usedBy.length > 0 && (
        <div className="mt-1 text-[9px] text-muted-foreground">
          {data.usedBy.slice(0, 3).join(", ")}{data.usedBy.length > 3 ? ` +${data.usedBy.length - 3}` : ""}
        </div>
      )}

    </div>
  );
}

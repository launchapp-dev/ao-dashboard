import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

interface Props {
  data: {
    label: string;
    count: number;
    color: string;
    icon: string;
    expanded: boolean;
    onClick: () => void;
  };
}

export function GroupNode({ data }: Props) {
  return (
    <div
      onClick={data.onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.onClick();
        }
      }}
      role="button"
      tabIndex={0}
      className={cn(
        "min-w-[150px] rounded-[16px] border px-4 py-3 font-sans transition-colors",
        data.expanded ? "bg-card" : "bg-secondary/50"
      )}
      style={{ borderColor: data.expanded ? "#465063" : "#374151" }}
    >
      <Handle type="target" position={Position.Left} style={{ background: data.color }} />

      <div className="flex items-center gap-2">
        <span className="text-sm">{data.icon}</span>
        <span className="font-bold text-[11px] uppercase tracking-[0.18em] text-foreground">{data.label}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{data.count}</span>
        <span className="ml-1 text-[10px] text-muted-foreground">{data.expanded ? "▾" : "▸"}</span>
      </div>

      <Handle type="source" position={Position.Right} style={{ background: data.color }} />
    </div>
  );
}

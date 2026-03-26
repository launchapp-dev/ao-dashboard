import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

interface Props {
  data: {
    name: string;
    model: string;
    tool: string;
    mcp_servers: string[];
    usedIn: string[];
    system_prompt?: string;
    expanded?: boolean;
    onToggle?: () => void;
  };
}

export function AgentNode({ data }: Props) {
  const expanded = data.expanded ?? false;

  return (
    <div
      onClick={data.onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.onToggle?.();
        }
      }}
      role="button"
      tabIndex={0}
      className={cn(
        "rounded-[16px] border border-border bg-card px-3 py-3 font-sans cursor-pointer transition-all",
        expanded ? "min-w-[280px] max-w-[400px]" : "min-w-[160px] max-w-[220px]"
      )}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#465063" }} />

      <div className="mb-1 flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-muted-foreground/50 shrink-0" />
        <span className="font-semibold text-[12px] text-foreground">{data.name}</span>
      </div>
      <div className="font-mono text-[10px] text-muted-foreground">
        {data.model.replace("kimi-code/", "")}
        <span className="ml-1 text-muted-foreground">({data.tool})</span>
      </div>
      {data.mcp_servers.length > 0 && (
        <div className="flex gap-1 mt-1 flex-wrap">
          {data.mcp_servers.map((s) => (
            <span key={s} className="rounded-full bg-secondary px-2 py-0.5 text-[9px] text-muted-foreground">{s}</span>
          ))}
        </div>
      )}
      {data.usedIn.length > 0 && (
        <div className="mt-1 text-[9px] text-muted-foreground">
          used in: {data.usedIn.slice(0, 4).join(", ")}{data.usedIn.length > 4 ? ` +${data.usedIn.length - 4}` : ""}
        </div>
      )}

      {expanded && data.system_prompt && (
        <div className="mt-2 border-t border-border/30 pt-2">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">System Prompt</div>
          <div className="max-h-[180px] overflow-auto whitespace-pre-wrap rounded bg-background/50 p-2 font-mono text-[10px] leading-[14px] text-muted-foreground">
            {data.system_prompt}
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: "#465063" }} />
    </div>
  );
}

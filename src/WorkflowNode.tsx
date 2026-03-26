import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

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
      name?: string;
      description?: string;
      phases?: string[];
    };
    onClick?: () => void;
    expanded?: boolean;
    onToggle?: () => void;
  };
}

export function WorkflowNode({ data }: Props) {
  const expanded = data.expanded ?? false;
  const { workflow: wf, onClick } = data;

  const isRunning = wf.status === "running";
  const color = isRunning ? "#6d83a6" : "#465063";

  return (
    <div
      onClick={() => {
        if (onClick && !expanded) onClick();
        data.onToggle?.();
      }}
      className={cn(
        "rounded-lg font-sans cursor-pointer transition-all",
        expanded ? "min-w-[220px]" : "min-w-[180px]"
      )}
      style={{
        background: isRunning ? "rgba(109, 131, 166, 0.08)" : "hsl(220 16% 11%)",
        border: `1.5px solid ${color}`,
        padding: "8px 14px",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: color }} />

      <div className="flex items-center gap-1.5 mb-1">
        {isRunning && <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />}
        {wf.isScheduled && !isRunning && <span className="text-[9px] text-muted-foreground">⏱</span>}
        <span className="font-semibold text-xs text-foreground">{wf.workflowRef}</span>
        {wf.phaseCount && <span className="text-[9px] text-muted-foreground/40">{wf.phaseCount}p</span>}
      </div>

      {wf.currentPhase && (
        <div className="text-[11px] text-muted-foreground">→ <span className="text-foreground">{wf.currentPhase}</span></div>
      )}

      {wf.cron && <div className="text-[9px] text-muted-foreground/40 font-mono">{wf.cron}</div>}

      {expanded && (
        <div className="mt-2 pt-2 border-t border-border/30 text-[9px]">
          {wf.name && <div className="text-muted-foreground mb-0.5">{wf.name}</div>}
          {wf.description && <div className="text-muted-foreground/50 mb-1">{wf.description}</div>}
          <div className="text-muted-foreground/40">
            <span className="text-muted-foreground/60">Status:</span> <span className={isRunning ? "text-primary" : "text-muted-foreground/40"}>{wf.status}</span>
          </div>
          {wf.phases && wf.phases.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {wf.phases.map((p, i) => (
                <span key={i} className="rounded bg-secondary px-1 py-px text-[8px] text-muted-foreground">{i + 1}. {p}</span>
              ))}
            </div>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: color }} />
    </div>
  );
}

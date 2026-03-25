import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

interface Props {
  data: {
    phase: string;
    index?: string;
    workflowRef: string;
    mode?: string;
    agent?: string;
    command?: string;
    command_args?: string[];
    directive?: string;
    model?: string;
    isActive?: boolean;
    timeout_secs?: number;
    cwd_mode?: string;
    expanded?: boolean;
    onToggle?: () => void;
  };
}

export function PhaseNode({ data }: Props) {
  const expanded = data.expanded ?? false;
  const { phase, index, mode, agent, command, model, isActive, directive } = data;

  const isCommand = mode === "command";
  const color = isActive ? "#22c55e" : isCommand ? "#38bdf8" : "#a78bfa";

  return (
    <div
      onClick={data.onToggle}
      className={cn(
        "rounded-md font-sans text-[11px] cursor-pointer transition-all",
        expanded ? "min-w-[260px] max-w-[320px]" : "min-w-[160px] max-w-[220px]"
      )}
      style={{
        background: isActive ? "#0a1a0a" : "hsl(225 35% 7%)",
        border: `1px solid ${color}${isActive ? "" : "40"}`,
        padding: "6px 10px",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: color }} />

      <div className="flex items-center gap-1.5">
        {isActive && <span className="w-[5px] h-[5px] rounded-full bg-chart-1 animate-pulse" />}
        <span className="text-[9px] px-1 py-px rounded font-semibold uppercase" style={{ background: `${color}20`, color }}>{isCommand ? "cmd" : "agent"}</span>
        <span className="font-medium">{phase}</span>
        {index && <span className="text-muted-foreground/40">({index})</span>}
      </div>

      {(agent || command || model) && (
        <div className="mt-0.5 text-[9px] text-muted-foreground/60 overflow-hidden text-ellipsis whitespace-nowrap">
          {isCommand && command && <span className="text-primary">{command}</span>}
          {!isCommand && agent && <span className="text-accent">{agent}</span>}
          {model && <span className="text-muted-foreground/30"> · {model.replace("kimi-code/", "")}</span>}
        </div>
      )}

      {expanded && (
        <div className="mt-2 pt-2 border-t border-border/30 text-[9px] space-y-1">
          {isCommand && command && (
            <div className="font-mono bg-background/50 p-1.5 rounded text-primary">
              $ {command} {data.command_args?.join(" ") || ""}
              {data.cwd_mode && <div className="text-muted-foreground/30">cwd: {data.cwd_mode}</div>}
              {data.timeout_secs && <div className="text-muted-foreground/30">timeout: {data.timeout_secs}s</div>}
            </div>
          )}
          {directive && (
            <div className="font-mono bg-background/50 p-1.5 rounded text-muted-foreground/70 max-h-[120px] overflow-auto whitespace-pre-wrap leading-[13px]">
              {directive}
            </div>
          )}
          {!directive && !command && <div className="text-muted-foreground/30 italic">No directive configured</div>}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: color }} />
    </div>
  );
}

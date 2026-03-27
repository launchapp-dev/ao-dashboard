import { cn } from "@/lib/utils";
import type { StreamEvent } from "./types";
import { MarkdownContent } from "./MarkdownContent";
import {
  getEventRunId,
  getPrimaryBody,
  getToolParams,
  getToolPaths,
  isMarkdownPreferredEvent,
  isToolPathParamKey,
  shouldRenderMarkdownBody,
} from "./lib/logEvent";

interface Props {
  event: StreamEvent;
  compact?: boolean;
  onWorkflowClick?: (workflowRef: string) => void;
  showProject?: boolean;
}

interface ToolDescriptor {
  category: string;
  label: string;
  accentClass: string;
}

function getToolServer(tool: string | undefined) {
  if (!tool?.startsWith("mcp__")) {
    return null;
  }

  return tool.split("__")[1] ?? null;
}

function getToolAction(tool: string | undefined) {
  if (!tool?.startsWith("mcp__")) {
    return null;
  }

  const parts = tool.split("__");
  return parts.slice(2).join("__") || null;
}

function getToolDescriptor(tool: string | undefined): ToolDescriptor | null {
  if (!tool) {
    return null;
  }

  if (tool.startsWith("mcp__")) {
    const parts = tool.split("__");
    const server = parts[1] || "unknown";
    return {
      category: "mcp",
      label: `mcp/${server}`,
      accentClass: "bg-chart-1/10 text-chart-1",
    };
  }

  if (tool === "Bash") {
    return {
      category: "shell",
      label: "shell",
      accentClass: "bg-chart-4/10 text-chart-4",
    };
  }

  if (["Read", "Write", "Edit", "MultiEdit", "Glob", "LS", "Grep", "WebFetch", "TodoWrite"].includes(tool)) {
    return {
      category: "builtin",
      label: "builtin",
      accentClass: "bg-primary/10 text-primary",
    };
  }

  return {
    category: "tool",
    label: "tool",
    accentClass: "bg-secondary text-muted-foreground",
  };
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatParamValue(value: unknown) {
  if (value == null) {
    return "null";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return formatJson(value);
}

function isSimpleParamValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null;
}

function getSummaryMessage(event: StreamEvent) {
  if (event.cat === "llm.output") {
    return event.role ? `${event.role} output` : "LLM output";
  }

  if (event.cat === "llm.thinking") {
    return "LLM thinking";
  }

  if (event.cat === "llm.error") {
    return "LLM error";
  }

  return event.msg;
}

export function LogEventRow({ event, compact = false, onWorkflowClick, showProject = false }: Props) {
  const toolParams = getToolParams(event);
  const toolPaths = getToolPaths(event);
  const toolDescriptor = getToolDescriptor(event.tool);
  const toolServer = getToolServer(event.tool);
  const toolAction = getToolAction(event.tool);
  const runId = getEventRunId(event);
  const body = getPrimaryBody(event);
  const summaryMessage = getSummaryMessage(event);
  const showMarkdownBody = shouldRenderMarkdownBody(event, body);
  const command = typeof toolParams?.command === "string" ? toolParams.command : null;
  const description = typeof toolParams?.description === "string" ? toolParams.description : null;
  const remainingParams = toolParams
    ? Object.entries(toolParams).filter(([key]) => key !== "command" && key !== "description" && !isToolPathParamKey(key))
    : [];
  const hasDetails = Boolean(
    showMarkdownBody
      || event.error
      || toolParams
      || toolPaths.length > 0
      || event.subject_id
      || runId
      || event.role
      || event.model,
  );

  return (
    <details
      className={cn(
        "group border-b border-border/30 px-3 py-2 text-foreground/86 open:bg-card/60 hover:bg-card/40",
        event.level === "error" && "border-l-2 border-l-chart-5",
        event.level === "warn" && "border-l-2 border-l-chart-4",
      )}
      open={!compact && hasDetails && (isMarkdownPreferredEvent(event) || event.cat.startsWith("llm.tool") || event.level === "error")}
    >
      <summary className="cursor-pointer list-none">
        <div className={cn("flex min-w-0 gap-2", compact ? "items-start" : "items-center")}>
          <span className="min-w-[55px] shrink-0 text-muted-foreground">{event.ts.slice(11, 19)}</span>
          {showProject && <span className="hidden min-w-[120px] shrink-0 font-medium text-foreground sm:block">{event.project}</span>}
          <span className="min-w-[84px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">{event.cat}</span>
          {event.workflow_ref && (
            <button
              type="button"
              onClick={(clickEvent) => {
                clickEvent.preventDefault();
                clickEvent.stopPropagation();
                onWorkflowClick?.(event.workflow_ref!);
              }}
              className={cn(
                "max-w-[120px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-left text-primary",
                !onWorkflowClick && "pointer-events-none",
              )}
            >
              {event.workflow_ref}
            </button>
          )}
          {toolDescriptor && <span className={cn("shrink-0 rounded px-1.5 py-px text-[9px] font-semibold", toolDescriptor.accentClass)}>{toolDescriptor.label}</span>}
          {event.tool && <span className="shrink-0 rounded bg-secondary px-1.5 py-px text-[9px] text-muted-foreground">{event.tool}</span>}
          {toolPaths[0] && (
            <span
              className="max-w-[260px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap rounded bg-secondary px-1.5 py-px text-[9px] text-muted-foreground"
              title={toolPaths[0]}
            >
              {toolPaths[0]}
            </span>
          )}
          {toolPaths.length > 1 && (
            <span className="shrink-0 rounded bg-secondary px-1 py-px text-[9px] text-muted-foreground">
              +{toolPaths.length - 1} paths
            </span>
          )}
          {event.task_id && event.task_id !== "cron" && <span className="shrink-0 rounded bg-secondary px-1 py-px text-[9px] text-muted-foreground">{event.task_id}</span>}
          <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", compact ? "leading-4" : "leading-5")}>{summaryMessage}</span>
        </div>
      </summary>

      {hasDetails && (
        <div className="mt-2 space-y-2 pl-[63px]">
          <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
            {toolDescriptor && <span>tool type: {toolDescriptor.label}</span>}
            {toolServer && <span>server: {toolServer}</span>}
            {toolAction && <span>action: {toolAction}</span>}
            {event.role && <span>role: {event.role}</span>}
            {event.phase_id && <span>phase: {event.phase_id}</span>}
            {event.workflow_id && <span>workflow: {event.workflow_id}</span>}
            {runId && <span>run: {runId}</span>}
            {event.model && <span>model: {event.model.replace("kimi-code/", "")}</span>}
            {event.subject_id && <span>subject: {event.subject_id}</span>}
          </div>

          {showMarkdownBody && (
            <div className="rounded border border-border/70 bg-background px-3 py-2">
              <MarkdownContent content={body} />
            </div>
          )}

          {event.error && event.error !== body && (
            <div className="rounded border border-chart-5/20 bg-chart-5/8 px-3 py-2 text-chart-5">
              <MarkdownContent content={event.error} className="text-chart-5" />
            </div>
          )}

          {toolPaths.length > 0 && (
            <div className="rounded border border-border/70 bg-background px-3 py-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Paths</div>
              <div className="flex flex-wrap gap-2">
                {toolPaths.map((path) => (
                  <code
                    key={path}
                    className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded bg-secondary px-1.5 py-1 font-mono text-[10px] text-foreground"
                    title={path}
                  >
                    {path}
                  </code>
                ))}
              </div>
            </div>
          )}

          {command && (
            <div className="rounded border border-border/70 bg-background">
              <div className="border-b border-border/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Command
              </div>
              <pre className="overflow-x-auto px-3 py-2 text-[11px] leading-5 whitespace-pre-wrap break-words text-foreground">
                {command}
              </pre>
            </div>
          )}

          {description && (
            <div className="rounded border border-border/70 bg-background px-3 py-2 text-[11px] leading-5 text-foreground">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Description</div>
              <MarkdownContent content={description} />
            </div>
          )}

          {remainingParams.length > 0 && (
            <div className="rounded border border-border/70 bg-background">
              <div className="border-b border-border/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Tool Params
              </div>
              <div className="divide-y divide-border/50">
                {remainingParams.map(([key, value]) => (
                  <div key={key} className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 px-3 py-2 text-[11px] leading-5">
                    <div className="text-muted-foreground">{key}</div>
                    {isSimpleParamValue(value) ? (
                      <div className="whitespace-pre-wrap break-words text-foreground">{formatParamValue(value)}</div>
                    ) : (
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-foreground">{formatJson(value)}</pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

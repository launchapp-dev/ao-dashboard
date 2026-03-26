import { LogEventRow } from "./LogEventRow";
import type { StreamEvent } from "./types";

export type LogGroupMode = "flat" | "workflow" | "conversation";

interface Props {
  events: StreamEvent[];
  groupMode: LogGroupMode;
  showProject?: boolean;
  onWorkflowClick?: (workflowRef: string) => void;
}

interface EventBlock {
  id: string;
  label: string;
  detail: string | null;
  events: StreamEvent[];
}

function getEventRunId(event: StreamEvent) {
  return typeof event.run_id === "string"
    ? event.run_id
    : typeof event.meta?.run_id === "string"
      ? event.meta.run_id
      : null;
}

function getConversationIdentity(event: StreamEvent) {
  return getEventRunId(event) ?? event.workflow_id ?? event.task_id ?? event.workflow_ref ?? event.phase_id ?? "ungrouped";
}

function getWorkflowIdentity(event: StreamEvent) {
  return event.workflow_id ?? event.workflow_ref ?? event.phase_id ?? "ungrouped";
}

function getEventProjectIdentity(event: StreamEvent) {
  return event.project_root ?? event.project;
}

function getConversationLabel(event: StreamEvent) {
  const runId = getEventRunId(event);
  if (runId) {
    return event.workflow_ref ? `${event.workflow_ref} conversation` : "Conversation";
  }

  if (event.workflow_ref) {
    return `${event.workflow_ref} conversation`;
  }

  return "Conversation";
}

function getConversationDetail(event: StreamEvent) {
  const runId = getEventRunId(event);
  if (runId) {
    return runId;
  }

  if (event.workflow_id) {
    return event.workflow_id;
  }

  return event.task_id ?? null;
}

function getWorkflowLabel(event: StreamEvent) {
  return event.workflow_ref ?? event.phase_id ?? "Workflow";
}

function getWorkflowDetail(event: StreamEvent) {
  return event.workflow_id ?? event.task_id ?? null;
}

function buildBlocks(events: StreamEvent[], groupMode: LogGroupMode): EventBlock[] {
  if (groupMode === "flat") {
    return events.map((event, index) => ({
      id: `${getEventProjectIdentity(event)}:${index}:${event.ts}:${event.cat}`,
      label: "",
      detail: null,
      events: [event],
    }));
  }

  const blocks: EventBlock[] = [];

  for (const event of events) {
    const identity = groupMode === "workflow"
      ? `${getEventProjectIdentity(event)}:${getWorkflowIdentity(event)}`
      : `${getEventProjectIdentity(event)}:${getConversationIdentity(event)}`;
    const label = groupMode === "workflow" ? getWorkflowLabel(event) : getConversationLabel(event);
    const detail = groupMode === "workflow" ? getWorkflowDetail(event) : getConversationDetail(event);
    const lastBlock = blocks[blocks.length - 1];

    if (lastBlock && lastBlock.id === identity) {
      lastBlock.events.push(event);
      continue;
    }

    blocks.push({
      id: identity,
      label,
      detail,
      events: [event],
    });
  }

  return blocks;
}

export function LogEventList({ events, groupMode, showProject = false, onWorkflowClick }: Props) {
  const blocks = buildBlocks(events, groupMode);

  if (groupMode === "flat") {
    return (
      <>
        {blocks.map((block, blockIndex) => (
          <LogEventRow
            key={`${block.id}:${blockIndex}`}
            event={block.events[0]}
            showProject={showProject}
            onWorkflowClick={onWorkflowClick}
          />
        ))}
      </>
    );
  }

  return (
    <div className="space-y-3 pb-2">
      {blocks.map((block) => {
        const firstEvent = block.events[0];
        const lastEvent = block.events[block.events.length - 1];
        const timeRange = firstEvent.ts.slice(11, 19) === lastEvent.ts.slice(11, 19)
          ? firstEvent.ts.slice(11, 19)
          : `${firstEvent.ts.slice(11, 19)} - ${lastEvent.ts.slice(11, 19)}`;

        return (
          <section key={block.id} className="overflow-hidden rounded-lg border border-border/70 bg-card/35">
            <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-background/70 px-3 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {groupMode === "workflow" ? "Workflow" : "Conversation"}
              </span>
              <span className="text-[11px] font-semibold text-foreground">{block.label}</span>
              {block.detail && (
                <span className="rounded bg-secondary px-1.5 py-px text-[9px] text-muted-foreground">
                  {block.detail}
                </span>
              )}
              {showProject && (
                <span className="rounded bg-secondary px-1.5 py-px text-[9px] text-muted-foreground">
                  {firstEvent.project}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground">{block.events.length} events</span>
              <div className="flex-1" />
              <span className="text-[10px] text-muted-foreground">{timeRange}</span>
            </div>

            <div>
              {block.events.map((event, index) => (
                <LogEventRow
                  key={`${block.id}:${event.ts}:${event.cat}:${event.task_id ?? ""}:${index}`}
                  event={event}
                  showProject={showProject}
                  onWorkflowClick={onWorkflowClick}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

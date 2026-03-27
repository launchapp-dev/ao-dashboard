import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "./MarkdownContent";
import { LogFlowEdge } from "./LogFlowEdge";
import { LogFlowNode, type LogFlowNodeData } from "./LogFlowNode";
import { getEventRunId, getPrimaryBody, getToolParams, getToolPaths } from "./lib/logEvent";
import type { LogGroupMode } from "./LogEventList";
import type { StreamEvent } from "./types";

const MAX_GRAPH_EVENTS = 220;
const MAX_BURSTS_PER_LANE = 8;
const DEFAULT_TRAIL_LENGTH = 8;

const nodeTypes = {
  log: LogFlowNode,
};

const edgeTypes = {
  signal: LogFlowEdge,
};

type EventTone = NonNullable<LogFlowNodeData["tone"]>;

interface EventInsights {
  body: string;
  runId: string | null;
  toolParams: Record<string, unknown> | null;
  command: string | null;
  description: string | null;
  toolType: string | null;
  toolServer: string | null;
  toolAction: string | null;
  files: string[];
  jsonBlocks: unknown[];
  jsonHighlights: string[];
}

interface GraphEventRecord {
  id: string;
  laneId: string;
  event: StreamEvent;
  insights: EventInsights;
  tone: EventTone;
  globalIndex: number;
  laneIndex: number;
}

interface BurstRecord {
  id: string;
  laneId: string;
  laneTitle: string;
  laneSubtitle: string | null;
  events: GraphEventRecord[];
  burstIndex: number;
  startIndex: number;
  endIndex: number;
  dominantTone: EventTone;
  title: string;
  subtitle: string | null;
  message: string | null;
  badges: string[];
  files: string[];
  jsonHighlights: string[];
}

interface LaneRecord {
  id: string;
  title: string;
  subtitle: string | null;
  events: GraphEventRecord[];
  bursts: BurstRecord[];
}

function getGraphIdentity(event: StreamEvent, groupMode: LogGroupMode) {
  if (groupMode === "workflow") {
    return event.workflow_id ?? event.workflow_ref ?? event.phase_id ?? "workflow";
  }

  if (groupMode === "conversation") {
    return getEventRunId(event) ?? event.workflow_id ?? event.task_id ?? event.workflow_ref ?? event.phase_id ?? "conversation";
  }

  return "timeline";
}

function getLaneTitle(event: StreamEvent, groupMode: LogGroupMode) {
  if (groupMode === "workflow") {
    return event.workflow_ref ?? event.phase_id ?? "Workflow";
  }

  if (groupMode === "conversation") {
    return event.workflow_ref ? `${event.workflow_ref} conversation` : "Conversation";
  }

  return "Timeline";
}

function getLaneSubtitle(event: StreamEvent, groupMode: LogGroupMode) {
  if (groupMode === "workflow") {
    return event.workflow_id ?? event.task_id ?? null;
  }

  if (groupMode === "conversation") {
    return getEventRunId(event) ?? event.workflow_id ?? event.task_id ?? null;
  }

  return null;
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

  return tool.split("__").slice(2).join("__") || null;
}

function getToolType(tool: string | undefined) {
  if (!tool) {
    return null;
  }

  if (tool.startsWith("mcp__")) {
    const server = getToolServer(tool);
    return server ? `mcp/${server}` : "mcp";
  }

  if (tool === "Bash") {
    return "shell";
  }

  if (["Read", "Write", "Edit", "MultiEdit", "Glob", "LS", "Grep", "WebFetch", "TodoWrite"].includes(tool)) {
    return "builtin";
  }

  return "tool";
}

function getEventTone(event: StreamEvent): EventTone {
  if (event.level === "error" || event.cat.endsWith(".error")) {
    return "error";
  }

  if (event.level === "warn") {
    return "warn";
  }

  if (event.cat.startsWith("llm.tool")) {
    return "tool";
  }

  if (event.cat === "llm.output") {
    return "output";
  }

  if (event.cat === "llm.thinking") {
    return "thinking";
  }

  return "default";
}

function parseJsonValue(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function extractJsonBlocks(text: string) {
  const blocks: unknown[] = [];
  const fencedJson = text.match(/```json\s*([\s\S]*?)```/gi) ?? [];

  for (const block of fencedJson) {
    const payload = block.replace(/```json\s*/i, "").replace(/```$/, "").trim();
    const parsed = parseJsonValue(payload);
    if (parsed) {
      blocks.push(parsed);
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = parseJsonValue(trimmed);
    if (parsed) {
      blocks.push(parsed);
    }
  }

  return blocks;
}

function extractFilePaths(text: string) {
  const matches = new Set<string>();
  const absoluteMatches = text.match(/\/Users\/[^\s`"'()]+/g) ?? [];
  const relativeMatches = text.match(/\b(?:\.{0,2}\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g) ?? [];

  for (const value of [...absoluteMatches, ...relativeMatches]) {
    matches.add(value.replace(/[),.:;]+$/, ""));
  }

  return Array.from(matches).slice(0, 12);
}

function stringifyValue(value: unknown) {
  if (value == null) {
    return "null";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatJson(value: unknown) {
  return stringifyValue(value);
}

function getJsonHighlights(jsonBlocks: unknown[]) {
  const highlights = new Set<string>();

  for (const block of jsonBlocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }

    const record = block as Record<string, unknown>;
    if (typeof record.verdict === "string") {
      highlights.add(`verdict:${record.verdict}`);
    }
    if (typeof record.reason === "string") {
      highlights.add("reason");
    }
    if (typeof record.phase_decision === "string") {
      highlights.add(`decision:${record.phase_decision}`);
    }
    if (Array.isArray(record.tasks)) {
      highlights.add(`tasks:${record.tasks.length}`);
    }

    Object.keys(record)
      .slice(0, 6)
      .forEach((key) => highlights.add(key));
  }

  return Array.from(highlights).slice(0, 8);
}

function buildInsights(event: StreamEvent): EventInsights {
  const body = getPrimaryBody(event);
  const toolParams = getToolParams(event);
  const toolPaths = getToolPaths(event);
  const command = typeof toolParams?.command === "string" ? toolParams.command : null;
  const description = typeof toolParams?.description === "string" ? toolParams.description : null;
  const textPool = [
    body,
    event.msg,
    event.error ?? "",
    command ?? "",
    description ?? "",
    toolParams ? stringifyValue(toolParams) : "",
  ].join("\n");

  return {
    body,
    runId: getEventRunId(event),
    toolParams,
    command,
    description,
    toolType: getToolType(event.tool),
    toolServer: getToolServer(event.tool),
    toolAction: getToolAction(event.tool),
    files: Array.from(new Set([...toolPaths, ...extractFilePaths(textPool)])).slice(0, 12),
    jsonBlocks: [...extractJsonBlocks(body), ...(event.error ? extractJsonBlocks(event.error) : [])],
    jsonHighlights: getJsonHighlights([...extractJsonBlocks(body), ...(event.error ? extractJsonBlocks(event.error) : [])]),
  };
}

function compactMessage(insights: EventInsights) {
  if (insights.command) {
    return insights.command;
  }

  const body = insights.body.replace(/\s+/g, " ").trim();
  return body.length > 220 ? `${body.slice(0, 217)}...` : body;
}

function getEventTitle(event: StreamEvent, insights: EventInsights) {
  if (event.cat.startsWith("llm.tool") && insights.toolAction) {
    return insights.toolAction;
  }

  if (event.tool) {
    return event.tool;
  }

  if (event.cat === "llm.output") {
    return event.role ? `${event.role} output` : "LLM output";
  }

  if (event.cat === "llm.thinking") {
    return "LLM thinking";
  }

  return event.cat;
}

function getEdgeColor(tone: EventTone) {
  switch (tone) {
    case "error":
      return "#b85c5c";
    case "warn":
      return "#c3893d";
    case "tool":
      return "#7aa2d1";
    case "output":
      return "#5d9a80";
    case "thinking":
      return "#6d83a6";
    default:
      return "#4b5a71";
  }
}

function getPlaybackOpacity(distance: number) {
  if (distance <= 0) return 1;
  if (distance === 1) return 0.92;
  if (distance <= 3) return 0.74;
  if (distance <= 6) return 0.46;
  return 0.16;
}

function getPlaybackScale(distance: number) {
  if (distance <= 0) return 1;
  if (distance <= 2) return 0.99;
  if (distance <= 5) return 0.975;
  return 0.955;
}

function getCategoryFamily(event: StreamEvent) {
  return event.cat.split(".").slice(0, 2).join(".");
}

function shouldStartNewBurst(current: GraphEventRecord[], next: GraphEventRecord) {
  const previous = current[current.length - 1];
  if (!previous) {
    return false;
  }

  if (current.length >= 6) {
    return true;
  }

  if (previous.event.phase_id !== next.event.phase_id && current.length >= 2) {
    return true;
  }

  if ((previous.tone === "error") !== (next.tone === "error")) {
    return true;
  }

  if (previous.insights.toolAction !== next.insights.toolAction && (previous.insights.toolAction || next.insights.toolAction) && current.length >= 2) {
    return true;
  }

  return getCategoryFamily(previous.event) !== getCategoryFamily(next.event) && current.length >= 3;
}

function mergeBurstWindows(windows: GraphEventRecord[][]) {
  if (windows.length <= MAX_BURSTS_PER_LANE) {
    return windows;
  }

  const groupSize = Math.ceil(windows.length / MAX_BURSTS_PER_LANE);
  const merged: GraphEventRecord[][] = [];

  for (let index = 0; index < windows.length; index += groupSize) {
    merged.push(windows.slice(index, index + groupSize).flat());
  }

  return merged;
}

function getDominantTone(events: GraphEventRecord[]) {
  const counts = new Map<EventTone, number>();
  for (const event of events) {
    counts.set(event.tone, (counts.get(event.tone) ?? 0) + 1);
  }

  const order: EventTone[] = ["error", "warn", "tool", "output", "thinking", "default"];
  return order.reduce<EventTone>((best, tone) => {
    if ((counts.get(tone) ?? 0) > (counts.get(best) ?? 0)) {
      return tone;
    }
    return best;
  }, "default");
}

function summarizeBurst(events: GraphEventRecord[]) {
  const first = events[0];
  const last = events[events.length - 1];
  const titles = new Set(events.map((event) => getEventTitle(event.event, event.insights)));
  const phases = new Set(events.map((event) => event.event.phase_id).filter(Boolean));
  const families = new Set(events.map((event) => getCategoryFamily(event.event)));
  const files = new Set(events.flatMap((event) => event.insights.files));
  const jsonHighlights = new Set(events.flatMap((event) => event.insights.jsonHighlights));
  const tools = new Set(events
    .map((event) => event.insights.toolType)
    .filter((value): value is string => Boolean(value)));
  const preview = events
    .slice(0, 2)
    .map((event) => compactMessage(event.insights))
    .filter(Boolean);

  let title = `${events.length} events`;
  if (titles.size === 1) {
    title = Array.from(titles)[0] ?? title;
  } else if (phases.size === 1) {
    title = `phase ${Array.from(phases)[0]}`;
  } else if (families.size === 1) {
    title = Array.from(families)[0] ?? title;
  }

  const subtitleParts = [
    first.event.phase_id && phases.size === 1 ? `phase ${first.event.phase_id}` : null,
    first.event.workflow_ref ?? null,
    first.insights.runId ?? null,
  ].filter(Boolean);

  const badges = new Set<string>([
    `${events.length} events`,
    ...Array.from(tools).slice(0, 2),
  ]);

  if (files.size > 0) {
    badges.add(`${files.size} files`);
  }
  if (jsonHighlights.size > 0) {
    badges.add(`${jsonHighlights.size} json keys`);
  }
  if (first.event.task_id && first.event.task_id !== "cron") {
    badges.add(first.event.task_id);
  }

  return {
    title,
    subtitle: subtitleParts.join(" · ") || null,
    message: preview.join("\n\n") || compactMessage(last.insights),
    badges: Array.from(badges).slice(0, 6),
    files: Array.from(files).slice(0, 12),
    jsonHighlights: Array.from(jsonHighlights).slice(0, 8),
  };
}

function buildLaneBursts(lane: LaneRecord) {
  if (lane.events.length === 0) {
    return [];
  }

  const windows: GraphEventRecord[][] = [];
  let current: GraphEventRecord[] = [];

  for (const record of lane.events) {
    if (current.length === 0) {
      current.push(record);
      continue;
    }

    if (shouldStartNewBurst(current, record)) {
      windows.push(current);
      current = [record];
      continue;
    }

    current.push(record);
  }

  if (current.length > 0) {
    windows.push(current);
  }

  return mergeBurstWindows(windows).map((records, burstIndex) => {
    const summary = summarizeBurst(records);
    return {
      id: `burst:${lane.id}:${burstIndex}:${records[0]?.id ?? burstIndex}`,
      laneId: lane.id,
      laneTitle: lane.title,
      laneSubtitle: lane.subtitle,
      events: records,
      burstIndex,
      startIndex: records[0]?.globalIndex ?? 0,
      endIndex: records[records.length - 1]?.globalIndex ?? 0,
      dominantTone: getDominantTone(records),
      title: summary.title,
      subtitle: summary.subtitle,
      message: summary.message,
      badges: summary.badges,
      files: summary.files,
      jsonHighlights: summary.jsonHighlights,
    } satisfies BurstRecord;
  });
}

function getBurstMeta(burst: BurstRecord) {
  const first = burst.events[0]?.event.ts.slice(11, 19);
  const last = burst.events[burst.events.length - 1]?.event.ts.slice(11, 19);

  if (!first || !last || first === last) {
    return first ?? "";
  }

  return `${first} -> ${last}`;
}

interface Props {
  events: StreamEvent[];
  groupMode: LogGroupMode;
}

export function LogFlow({ events, groupMode }: Props) {
  const [selectedBurstId, setSelectedBurstId] = useState<string | null>(null);
  const [selectedDetailEventId, setSelectedDetailEventId] = useState<string | null>(null);
  const [focusedLaneId, setFocusedLaneId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 2 | 4>(2);
  const [trailLength, setTrailLength] = useState(DEFAULT_TRAIL_LENGTH);

  const graph = useMemo(() => {
    const trimmed = events.slice(-MAX_GRAPH_EVENTS);
    const lanes = new Map<string, LaneRecord>();

    trimmed.forEach((event, index) => {
      const laneId = getGraphIdentity(event, groupMode);
      const insights = buildInsights(event);
      const existing = lanes.get(laneId);
      const laneIndex = existing?.events.length ?? 0;
      const record: GraphEventRecord = {
        id: `event:${laneId}:${index}:${event.ts}:${event.cat}`,
        laneId,
        event,
        insights,
        tone: getEventTone(event),
        globalIndex: index,
        laneIndex,
      };

      if (existing) {
        existing.events.push(record);
      } else {
        lanes.set(laneId, {
          id: laneId,
          title: getLaneTitle(event, groupMode),
          subtitle: getLaneSubtitle(event, groupMode),
          events: [record],
          bursts: [],
        });
      }
    });

    const laneList = Array.from(lanes.values())
      .map((lane) => ({ ...lane, bursts: buildLaneBursts(lane) }))
      .sort((left, right) => {
        const leftIndex = left.events[left.events.length - 1]?.globalIndex ?? 0;
        const rightIndex = right.events[right.events.length - 1]?.globalIndex ?? 0;
        return rightIndex - leftIndex;
      });

    const allBursts = laneList
      .flatMap((lane) => lane.bursts)
      .sort((left, right) => left.startIndex - right.startIndex);

    return { lanes: laneList, allBursts };
  }, [events, groupMode]);

  const maxStep = graph.allBursts.length > 0 ? graph.allBursts.length - 1 : 0;
  const [playhead, setPlayhead] = useState(maxStep);

  useEffect(() => {
    setPlayhead(maxStep);
    setIsPlaying(false);
  }, [maxStep, groupMode, events]);

  useEffect(() => {
    if (graph.allBursts.length === 0) {
      setSelectedBurstId(null);
      return;
    }

    if (!selectedBurstId || !graph.allBursts.some((burst) => burst.id === selectedBurstId)) {
      setSelectedBurstId(graph.allBursts[Math.min(playhead, graph.allBursts.length - 1)]?.id ?? graph.allBursts[graph.allBursts.length - 1]?.id ?? null);
    }
  }, [graph.allBursts, playhead, selectedBurstId]);

  useEffect(() => {
    if (!focusedLaneId) {
      return;
    }

    if (!graph.lanes.some((lane) => lane.id === focusedLaneId)) {
      setFocusedLaneId(null);
    }
  }, [focusedLaneId, graph.lanes]);

  useEffect(() => {
    if (!isPlaying || graph.allBursts.length === 0) {
      return;
    }

    const interval = window.setInterval(() => {
      setPlayhead((prev) => {
        if (prev >= maxStep) {
          window.clearInterval(interval);
          setIsPlaying(false);
          return maxStep;
        }

        return Math.min(prev + 1, maxStep);
      });
    }, Math.max(110, 420 / playbackSpeed));

    return () => window.clearInterval(interval);
  }, [graph.allBursts.length, isPlaying, maxStep, playbackSpeed]);

  const selectedBurst = useMemo(
    () => graph.allBursts.find((burst) => burst.id === selectedBurstId) ?? null,
    [graph.allBursts, selectedBurstId],
  );

  useEffect(() => {
    if (!selectedBurst) {
      setSelectedDetailEventId(null);
      return;
    }

    if (!selectedDetailEventId || !selectedBurst.events.some((event) => event.id === selectedDetailEventId)) {
      setSelectedDetailEventId(selectedBurst.events[selectedBurst.events.length - 1]?.id ?? null);
    }
  }, [selectedBurst, selectedDetailEventId]);

  const selectedDetailRecord = useMemo(
    () => selectedBurst?.events.find((event) => event.id === selectedDetailEventId) ?? selectedBurst?.events[selectedBurst.events.length - 1] ?? null,
    [selectedBurst, selectedDetailEventId],
  );

  const currentBurst = graph.allBursts[Math.min(playhead, maxStep)] ?? null;

  const rendered = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const laneSpacing = 430;
    const rowSpacing = 164;

    const visibleLanes = focusedLaneId
      ? graph.lanes.filter((lane) => lane.id === focusedLaneId)
      : graph.lanes;

    visibleLanes.forEach((lane, laneIndex) => {
      const x = laneIndex * laneSpacing;
      const visibleBursts = lane.bursts.filter((burst) => {
        const burstPosition = graph.allBursts.findIndex((candidate) => candidate.id === burst.id);
        if (burstPosition < 0) {
          return false;
        }

        if (burstPosition > playhead) {
          return burst.id === selectedBurstId;
        }

        const distance = playhead - burstPosition;
        return distance <= trailLength || burst.id === selectedBurstId;
      });
      visibleBursts.forEach((burst) => {
        const burstPosition = graph.allBursts.findIndex((candidate) => candidate.id === burst.id);
        const distance = burstPosition > playhead ? trailLength + 4 : playhead - burstPosition;
        const opacity = burst.id === selectedBurstId ? 1 : getPlaybackOpacity(distance);
        const scale = burst.id === selectedBurstId ? 1 : getPlaybackScale(distance);
        const isCurrent = currentBurst?.id === burst.id;
        const y = 36 + burst.burstIndex * rowSpacing;

        nodes.push({
          id: burst.id,
          type: "log",
          position: { x, y },
          style: {
            opacity,
            transform: `scale(${scale})`,
            transition: "opacity 220ms ease, transform 220ms ease",
            zIndex: isCurrent || burst.id === selectedBurstId ? 30 : 10,
          },
          data: {
            kind: "event",
            title: burst.title,
            subtitle: burst.subtitle,
            meta: getBurstMeta(burst),
            message: burst.message,
            tone: burst.dominantTone,
            badges: burst.badges,
            selected: burst.id === selectedBurstId,
            current: isCurrent,
          },
        });

        const previousVisible = lane.bursts
          .filter((candidate) => candidate.burstIndex < burst.burstIndex)
          .reverse()
          .find((candidate) => nodes.some((node) => node.id === candidate.id));
        if (previousVisible) {
          edges.push({
            id: `${previousVisible.id}->${burst.id}`,
            source: previousVisible.id,
            target: burst.id,
            type: "signal",
            markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: getEdgeColor(burst.dominantTone) },
            data: {
              active: isCurrent || (currentBurst?.laneId === lane.id && currentBurst.burstIndex - burst.burstIndex <= 2 && currentBurst.burstIndex >= burst.burstIndex),
              speed: playbackSpeed,
            },
            style: {
              stroke: getEdgeColor(burst.dominantTone),
              strokeWidth: isCurrent ? 2.8 : burst.dominantTone === "error" ? 2.2 : 1.6,
              opacity,
            },
          });
        }
      });
    });

    return { nodes, edges };
  }, [currentBurst, focusedLaneId, graph.allBursts, graph.lanes, playhead, selectedBurstId, trailLength]);

  return (
    <div className="flex h-full min-h-[680px] w-full flex-col gap-3">
      <div className="rounded-lg border border-border/60 bg-card/45 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (playhead >= maxStep) {
                setPlayhead(0);
              }
              setIsPlaying((prev) => !prev);
            }}
            className="rounded border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-semibold text-foreground"
          >
            {isPlaying ? "Pause" : playhead >= maxStep ? "Replay" : "Play"}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsPlaying(false);
              setPlayhead(0);
            }}
            className="rounded border border-border bg-background px-3 py-1 text-[11px] text-muted-foreground"
          >
            Reset
          </button>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>Speed</span>
            <select
              value={playbackSpeed}
              onChange={(event) => setPlaybackSpeed(Number(event.target.value) as 1 | 2 | 4)}
              className="rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground outline-none"
            >
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={4}>4x</option>
            </select>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>Trail</span>
            <select
              value={trailLength}
              onChange={(event) => setTrailLength(Number(event.target.value))}
              className="rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground outline-none"
            >
              <option value={4}>Short</option>
              <option value={8}>Medium</option>
              <option value={12}>Long</option>
            </select>
          </div>
          <div className="ml-auto text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
            {currentBurst ? `${getBurstMeta(currentBurst)} · ${currentBurst.title}` : "No events"}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={Math.max(maxStep, 0)}
            step={1}
            value={Math.min(playhead, maxStep)}
            onChange={(event) => {
              setIsPlaying(false);
              setPlayhead(Number(event.target.value));
            }}
            className="h-2 flex-1 accent-primary"
          />
          <span className="min-w-[82px] text-right text-[11px] text-muted-foreground">
            {graph.allBursts.length === 0 ? "0 / 0" : `${Math.min(playhead + 1, graph.allBursts.length)} / ${graph.allBursts.length}`}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setFocusedLaneId(null)}
            className={cn(
              "rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-wide",
              focusedLaneId === null ? "border-primary/35 bg-primary/12 text-foreground" : "border-border bg-background text-muted-foreground",
            )}
          >
            All lanes
          </button>
          {graph.lanes.map((lane) => (
            <button
              key={lane.id}
              type="button"
              onClick={() => setFocusedLaneId((prev) => prev === lane.id ? null : lane.id)}
              className={cn(
                "rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-wide",
                focusedLaneId === lane.id ? "border-primary/35 bg-primary/12 text-foreground" : "border-border bg-background text-muted-foreground",
              )}
            >
              {lane.title}
            </button>
          ))}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 w-full gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-h-0 overflow-hidden rounded-lg border border-border/60 bg-background/50">
          {rendered.nodes.length === 0 ? (
            <div className="flex h-full min-h-[460px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
              No visible graph nodes for the current filters.
            </div>
          ) : (
            <ReactFlow
              nodes={rendered.nodes}
              edges={rendered.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{ padding: 0.14, maxZoom: 1.15 }}
              minZoom={0.3}
              maxZoom={1.6}
              nodesDraggable={false}
              nodesConnectable={false}
              onNodeClick={(_, node) => {
                if (node.id.startsWith("burst:")) {
                  setSelectedBurstId(node.id);
                }
              }}
              proOptions={{ hideAttribution: true }}
            >
              <MiniMap pannable zoomable nodeStrokeWidth={2} />
              <Controls position="bottom-right" showInteractive={false} />
              <Background gap={18} size={1} color="rgba(255,255,255,0.06)" />
            </ReactFlow>
          )}
        </div>

        <div className="min-h-0 overflow-auto rounded-lg border border-border/60 bg-card/45">
          {!selectedBurst ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              Select a burst node to inspect the underlying messages, tool calls, JSON payloads, and files.
            </div>
          ) : (
            <div className="space-y-4 p-4">
              <div className="border-b border-border/60 pb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {selectedBurst.laneTitle}
                  </span>
                  <span className="rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                    {getBurstMeta(selectedBurst)}
                  </span>
                  <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                    {selectedBurst.events.length} events
                  </span>
                </div>
                <h3 className="mt-3 text-lg font-semibold text-foreground">
                  {selectedBurst.title}
                </h3>
                {selectedBurst.subtitle && (
                  <div className="mt-2 text-[11px] text-muted-foreground">{selectedBurst.subtitle}</div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedBurst.badges.map((badge) => (
                    <span key={badge} className="rounded bg-secondary px-2 py-1 text-[10px] text-foreground">
                      {badge}
                    </span>
                  ))}
                </div>
                {(selectedBurst.message || selectedBurst.files.length > 0) && (
                  <div className="mt-3 space-y-3 text-[12px] leading-5 text-muted-foreground">
                    {selectedBurst.message && (
                      <div className="text-foreground/90">
                        <MarkdownContent content={selectedBurst.message} />
                      </div>
                    )}
                    {selectedBurst.files.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {selectedBurst.files.map((file) => (
                          <span key={file} className="rounded bg-secondary px-2 py-1 text-[10px] text-foreground">
                            {file}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <section className="space-y-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Events</div>
                <div className="overflow-hidden rounded-lg border border-border/60 bg-background">
                  <div className="divide-y divide-border/60">
                    {selectedBurst.events.map((record) => (
                      <button
                        key={record.id}
                        type="button"
                        onClick={() => setSelectedDetailEventId(record.id)}
                        className={cn(
                          "w-full px-3 py-2 text-left transition-colors",
                          selectedDetailRecord?.id === record.id ? "bg-primary/8" : "hover:bg-white/3",
                        )}
                      >
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span>{record.event.ts.slice(11, 19)}</span>
                          <span>{record.event.cat}</span>
                          {record.event.phase_id && <span>{record.event.phase_id}</span>}
                        </div>
                        <div className="mt-1 text-[11px] font-semibold text-foreground">
                          {getEventTitle(record.event, record.insights)}
                        </div>
                        <div className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[10px] leading-4 text-muted-foreground">
                          {compactMessage(record.insights)}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              {selectedDetailRecord && (
                <>
                  <section className="space-y-2 border-t border-border/60 pt-4">
                    <div className="flex items-center gap-2">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Selected Event</div>
                      <span className="rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                        {selectedDetailRecord.event.ts}
                      </span>
                      {selectedDetailRecord.insights.toolType && (
                        <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                          {selectedDetailRecord.insights.toolType}
                        </span>
                      )}
                    </div>
                    <div className="rounded-lg bg-background/60 px-3 py-3">
                      <MarkdownContent content={selectedDetailRecord.insights.body} />
                    </div>
                  </section>

                  {selectedDetailRecord.insights.command && (
                    <section className="space-y-2">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Command</div>
                      <pre className="overflow-x-auto rounded-lg border border-border/60 bg-background px-3 py-3 text-[11px] leading-5 text-foreground whitespace-pre-wrap break-words">
                        {selectedDetailRecord.insights.command}
                      </pre>
                    </section>
                  )}

                  {selectedDetailRecord.insights.description && (
                    <section className="space-y-2">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Description</div>
                      <div className="rounded-lg border border-border/60 bg-background px-3 py-3">
                        <MarkdownContent content={selectedDetailRecord.insights.description} />
                      </div>
                    </section>
                  )}

                  {selectedDetailRecord.insights.toolParams && (
                    <section className="space-y-2">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Tool Params</div>
                      <div className="rounded-lg border border-border/60 bg-background">
                        <div className="divide-y divide-border/50">
                          {Object.entries(selectedDetailRecord.insights.toolParams).map(([key, value]) => (
                            <div key={key} className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 px-3 py-2 text-[11px] leading-5">
                              <div className="text-muted-foreground/70">{key}</div>
                              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-foreground">{formatJson(value)}</pre>
                            </div>
                          ))}
                        </div>
                      </div>
                    </section>
                  )}

                  {selectedDetailRecord.insights.jsonBlocks.length > 0 && (
                    <section className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">JSON Artifacts</div>
                        <div className="flex flex-wrap gap-1.5">
                          {selectedDetailRecord.insights.jsonHighlights.map((highlight) => (
                            <span key={highlight} className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
                              {highlight}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-2">
                        {selectedDetailRecord.insights.jsonBlocks.map((block, index) => (
                          <pre key={index} className="overflow-x-auto rounded-lg border border-border/60 bg-background px-3 py-3 text-[11px] leading-5 text-foreground whitespace-pre-wrap break-words">
                            {formatJson(block)}
                          </pre>
                        ))}
                      </div>
                    </section>
                  )}

                  <section className="space-y-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Raw Event</div>
                    <pre className="overflow-x-auto rounded-lg border border-border/60 bg-background px-3 py-3 text-[11px] leading-5 text-foreground whitespace-pre-wrap break-words">
                      {formatJson(selectedDetailRecord.event)}
                    </pre>
                  </section>

                  {selectedDetailRecord.event.meta && (
                    <section className="space-y-2">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Meta</div>
                      <pre className="overflow-x-auto rounded-lg border border-border/60 bg-background px-3 py-3 text-[11px] leading-5 text-foreground whitespace-pre-wrap break-words">
                        {formatJson(selectedDetailRecord.event.meta)}
                      </pre>
                    </section>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

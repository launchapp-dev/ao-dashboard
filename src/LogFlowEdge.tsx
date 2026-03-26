import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";

type SignalEdgeData = {
  active?: boolean;
  speed?: number;
};

function asNumber(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function LogFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const edgeData = (data ?? {}) as SignalEdgeData;
  const active = Boolean(edgeData.active);
  const speed = asNumber(edgeData.speed, 1);
  const stroke = typeof style?.stroke === "string" ? style.stroke : "#4b5a71";
  const strokeWidth = asNumber(style?.strokeWidth, active ? 2.6 : 1.8);
  const opacity = asNumber(style?.opacity, 1);
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: active ? 0.42 : 0.3,
  });
  const duration = `${Math.max(0.7, 2.25 / speed)}s`;

  return (
    <g className="log-flow-edge">
      <path
        d={edgePath}
        fill="none"
        stroke={stroke}
        strokeWidth={active ? strokeWidth * 4.4 : strokeWidth * 2.2}
        strokeOpacity={Math.min(opacity * (active ? 0.24 : 0.12), 0.32)}
        className={active ? "log-flow-edge-glow" : undefined}
        vectorEffect="non-scaling-stroke"
      />
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke,
          strokeWidth,
          opacity,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      />
      {active && (
        <>
          <path
            d={edgePath}
            fill="none"
            stroke="rgba(255,255,255,0.82)"
            strokeWidth={1.15}
            strokeOpacity={Math.min(opacity, 0.9)}
            strokeDasharray="10 18"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="log-flow-edge-trail"
            style={{ animationDuration: duration }}
            vectorEffect="non-scaling-stroke"
          />
          <circle
            r="3.4"
            fill={stroke}
            className="log-flow-edge-orb"
            style={{ animationDuration: duration, opacity: Math.min(opacity, 1) }}
          >
            <animateMotion dur={duration} repeatCount="indefinite" path={edgePath} />
          </circle>
        </>
      )}
    </g>
  );
}

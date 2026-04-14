import { invoke } from "@tauri-apps/api/core";
import cytoscape, {
  type Core as CytoscapeCore,
  type ElementDefinition,
} from "cytoscape";
import cytoscapeDagre from "cytoscape-dagre";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

cytoscape.use(cytoscapeDagre);

type StatusTone = "info" | "error";
type ResearchTab = "papers" | "search" | "graph" | "review" | "ideas";
type GraphView = "method" | "problem" | "idea";
type GraphNodeKind =
  | "task"
  | "pipeline"
  | "module"
  | "challenge"
  | "insight"
  | "idea";
type ReviewFilter =
  | "all"
  | "task"
  | "pipeline"
  | "module"
  | "challenge"
  | "insight"
  | "edge";

interface ResearchMemoryPanelProps {
  chatModel: string;
  extractProviderLabel?: string;
  extractFastModel: string;
  extractFallbackModel: string;
  pipelineSummaryModel: string;
  pipelineNameModel: string;
  edgeExtractModel: string;
  edgeValidateModel: string;
  translationModel: string;
  onOpenPathInApp?: (path: string, page?: number, snippet?: string) => void;
  ingestProgress?: {
    stage: string;
    current: number;
    total: number;
    message: string;
    noCandidateCount?: number;
    fallbackSuccessCount?: number;
    doubleFailureCount?: number;
  } | null;
  onStatus?: (message: string, tone?: StatusTone) => void;
}

interface StarGraphGlyph {
  id: string;
  label: string;
  kind: GraphNodeKind;
  kindLabel: string;
  x: number;
  y: number;
}

interface StarGraphEdgeFlow {
  id: string;
  d: string;
  edgeType: string;
  label?: string;
  isIdea?: boolean;
  from?: string;
  to?: string;
}

interface StarDustParticle {
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
}

interface EvidenceRef {
  paperId: string;
  paperTitle: string;
  paperPath: string;
  pageStart: number;
  pageEnd: number;
  chunkId?: string | null;
  snippet: string;
  sourceType: string;
}

interface ResearchSearchHit {
  id: string;
  paperId: string;
  path: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  snippet: string;
  score: number;
  relatedGraphNodes: string[];
}

interface ResearchGraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  aliases: string[];
  paperCount: number;
  supportCount: number;
  inDegree: number;
  outDegree: number;
  isOrphan: boolean;
}

interface ResearchGraphEdge {
  id: string;
  edgeType: string;
  from: string;
  to: string;
  supportCount: number;
}

interface ResearchGraph {
  view: GraphView;
  nodes: ResearchGraphNode[];
  edges: ResearchGraphEdge[];
}

interface RelatedPaperRef {
  paperId: string;
  title: string;
  path: string;
}

interface GraphAdjacentNode {
  nodeId: string;
  kind: string;
  label: string;
  edgeType: string;
  direction: string;
}

interface ResearchGraphNodeDetail {
  nodeId: string;
  kind: string;
  label: string;
  aliases: string[];
  description?: string | null;
  supportCount: number;
  evidence: EvidenceRef[];
  relatedPapers: RelatedPaperRef[];
  adjacentNodes: GraphAdjacentNode[];
}

interface ResearchGraphEdgeDetail {
  edgeId: string;
  edgeType: string;
  fromNodeId: string;
  fromLabel: string;
  toNodeId: string;
  toLabel: string;
  supportCount: number;
  evidence: EvidenceRef[];
  relatedPapers: RelatedPaperRef[];
}

interface ReviewRecord {
  reviewId: string;
  candidateId: string;
  paperId: string;
  paperTitle: string;
  paperPath: string;
  candidateKind: string;
  entityKind?: string | null;
  label?: string | null;
  description?: string | null;
  confidence: number;
  fromKind?: string | null;
  fromLabel?: string | null;
  toKind?: string | null;
  toLabel?: string | null;
  evidence: EvidenceRef[];
  suggestedCanonicalLabel?: string | null;
}

interface IdeaCandidate {
  id: string;
  ruleType: string;
  title: string;
  summary: string;
  confidence: number;
  challengeNodeId?: string | null;
  moduleNodeId?: string | null;
  taskNodeId?: string | null;
  pipelineNodeId?: string | null;
  evidence: EvidenceRef[];
}

interface ResearchPaperRecord {
  paperId: string;
  title: string;
  path: string;
  paperType: string;
  parseStatus: string;
  indexStatus: string;
  extractionStatus: string;
  chunkCount: number;
  candidateCount: number;
  pendingReviewCount: number;
  approvedCandidateCount: number;
  isInGraph: boolean;
  updatedAt: string;
}

interface ResearchExtractionDiagnosticsRecord {
  paperId: string;
  title: string;
  path: string;
  relationMapUnitCount: number;
  candidateConflictCount: number;
  pipelineSummaryEmptyCount: number;
  pipelineNameEmptyCount: number;
  edgeCandidateCount: number;
  edgeValidatedCount: number;
  edgeValidateFallbackCount: number;
  updatedAt: string;
}

const graphLaneDefinitions: Record<
  GraphView,
  Array<{ kind: GraphNodeKind; label: string }>
> = {
  method: [
    { kind: "task", label: "Task" },
    { kind: "pipeline", label: "Pipeline" },
    { kind: "module", label: "Module" },
  ],
  problem: [
    { kind: "challenge", label: "Challenge" },
    { kind: "insight", label: "Insight" },
  ],
  idea: [
    { kind: "challenge", label: "Challenge" },
    { kind: "insight", label: "Insight" },
    { kind: "task", label: "Task" },
    { kind: "pipeline", label: "Pipeline" },
    { kind: "module", label: "Module" },
    { kind: "idea", label: "Idea" },
  ],
};

const graphKindLabels: Record<GraphNodeKind, string> = {
  task: "Task",
  pipeline: "Pipeline",
  module: "Module",
  challenge: "Challenge",
  insight: "Insight",
  idea: "Idea",
};

const pageLabel = (pageStart: number, pageEnd: number) =>
  pageStart === pageEnd ? `p.${pageStart}` : `p.${pageStart}-${pageEnd}`;

const scoreLabel = (value: number) => `${Math.round(value * 100)}%`;

const paperStatusLabels: Record<string, string> = {
  indexing: "索引中",
  extracting: "抽取中",
  parsed_no_candidates: "已解析，无候选",
  awaiting_review: "待审核",
  in_graph: "已入图",
  parsed: "已解析",
  empty: "空文档",
};

const paperTypeLabels: Record<string, string> = {
  method: "Method",
  application: "Application",
  review: "Review",
};

const reviewFilterLabels: Record<ReviewFilter, string> = {
  all: "All",
  task: "Task",
  pipeline: "Pipeline",
  module: "Module",
  challenge: "Challenge",
  insight: "Insight",
  edge: "Edge",
};

const graphKindColors: Record<GraphNodeKind, string> = {
  task: "#ff8a34",
  pipeline: "#3aa7ff",
  module: "#22c67f",
  challenge: "#ff5f9f",
  insight: "#8a7bff",
  idea: "#fbbf24",
};

const graphKindCodes: Record<GraphNodeKind, string> = {
  task: "TASK",
  pipeline: "PIPE",
  module: "MOD",
  challenge: "CHAL",
  insight: "INS",
  idea: "IDEA",
};

const trimText = (value: string, limit: number) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
};

const formatGraphNodeLabel = (node: ResearchGraphNode) =>
  `${graphKindCodes[node.kind]}\n${node.label}`;

const ideaNodeId = (ideaId: string) => `idea:${ideaId}`;

const resolveIdeaSourceKind = (idea: IdeaCandidate, sourceId: string) => {
  if (idea.challengeNodeId === sourceId) return "challenge";
  if (idea.moduleNodeId === sourceId) return "module";
  if (idea.taskNodeId === sourceId) return "task";
  if (idea.pipelineNodeId === sourceId) return "pipeline";
  return "insight";
};

const ideaEdgeTypeForKind = (kind: GraphNodeKind) =>
  kind === "challenge" ? "resolves" : "inspired_by";

const buildGraphElements = (
  graph: ResearchGraph,
  view: GraphView,
): ElementDefinition[] => {
  const laneDefs = graphLaneDefinitions[view];
  const elements: ElementDefinition[] = [];
  const anchorIds = laneDefs.map((lane) => `__anchor_${view}_${lane.kind}`);
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const fallbackPositions = buildFallbackPositions(graph, view);
  const connectedNodeIds = new Set<string>();

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    connectedNodeIds.add(edge.from);
    connectedNodeIds.add(edge.to);
  }

  laneDefs.forEach((lane, index) => {
    elements.push({
      data: {
        id: anchorIds[index],
        label: lane.label,
        kind: lane.kind,
        isAnchor: true,
      },
      classes: "graph-anchor",
      selectable: false,
      grabbable: false,
      locked: true,
    });
    if (index > 0) {
      elements.push({
        data: {
          id: `__anchor_edge_${view}_${laneDefs[index - 1].kind}_${lane.kind}`,
          source: anchorIds[index - 1],
          target: anchorIds[index],
          isAnchor: true,
        },
        classes: "graph-anchor-edge",
        selectable: false,
      });
    }
  });

  for (const node of graph.nodes) {
    elements.push({
      data: {
        id: node.id,
        label: formatGraphNodeLabel(node),
        rawLabel: node.label,
        kind: node.kind,
        kindLabel: graphKindLabels[node.kind],
        color: graphKindColors[node.kind],
        paperCount: node.paperCount,
        supportCount: node.supportCount,
        isOrphan: node.isOrphan,
      },
      classes: `graph-node graph-node-${node.kind}${node.isOrphan ? " graph-node-orphan" : ""}`,
      selectable: true,
      grabbable: true,
      locked: false,
      position: fallbackPositions.get(node.id),
    });

    const anchorId = `__anchor_${view}_${node.kind}`;
    if (anchorIds.includes(anchorId) && !connectedNodeIds.has(node.id)) {
      elements.push({
        data: {
          id: `__anchor_attach_${view}_${node.id}`,
          source: anchorId,
          target: node.id,
          isAnchor: true,
        },
        classes: "graph-anchor-edge",
        selectable: false,
      });
    }
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    elements.push({
      data: {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        edgeType: edge.edgeType,
        supportCount: edge.supportCount,
      },
      classes: "graph-edge",
      selectable: true,
    });
  }

  return elements;
};

const buildFallbackPositions = (
  graph: ResearchGraph,
  view: GraphView,
): Map<string, { x: number; y: number }> => {
  const laneDefs = graphLaneDefinitions[view];
  const grouped = new Map<GraphNodeKind, ResearchGraphNode[]>();
  for (const lane of laneDefs) {
    grouped.set(lane.kind, []);
  }
  for (const node of graph.nodes) {
    if (!grouped.has(node.kind)) continue;
    grouped.get(node.kind)?.push(node);
  }
  for (const [kind, nodes] of grouped.entries()) {
    nodes.sort((left, right) => {
      if (right.supportCount !== left.supportCount) {
        return right.supportCount - left.supportCount;
      }
      if (right.paperCount !== left.paperCount) {
        return right.paperCount - left.paperCount;
      }
      return left.label.localeCompare(right.label);
    });
    grouped.set(kind, nodes);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const columnGap = 360;
  const leftPadding = 220;
  const topPadding = 180;
  const rowGap = 170;

  laneDefs.forEach((lane, laneIndex) => {
    const nodes = grouped.get(lane.kind) ?? [];
    const x = leftPadding + laneIndex * columnGap;
    nodes.forEach((node, nodeIndex) => {
      positions.set(node.id, {
        x,
        y: topPadding + nodeIndex * rowGap,
      });
    });
  });

  return positions;
};

const shouldFallbackToPresetLayout = (cy: CytoscapeCore) => {
  const nodes = cy.nodes(".graph-node");
  if (nodes.length <= 1) return false;

  const roundedPositions = nodes.map((node) => {
    const position = node.position();
    return `${Math.round(position.x)}:${Math.round(position.y)}`;
  });
  const uniquePositions = new Set(roundedPositions);
  if (uniquePositions.size <= 1) {
    return true;
  }

  const bounds = nodes.boundingBox();
  const width = Math.abs(bounds.w ?? bounds.x2 - bounds.x1);
  const height = Math.abs(bounds.h ?? bounds.y2 - bounds.y1);
  return width < 140 || height < 140;
};

export function ResearchMemoryPanel({
  chatModel,
  extractProviderLabel = "Ollama",
  extractFastModel,
  extractFallbackModel,
  pipelineSummaryModel,
  pipelineNameModel,
  edgeExtractModel,
  edgeValidateModel,
  translationModel,
  onOpenPathInApp,
  ingestProgress,
  onStatus,
}: ResearchMemoryPanelProps) {
  const [activeTab, setActiveTab] = useState<ResearchTab>("papers");
  const [papers, setPapers] = useState<ResearchPaperRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<
    ResearchExtractionDiagnosticsRecord[]
  >([]);
  const [isPapersLoading, setIsPapersLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ResearchSearchHit[]>([]);
  const [lastQuery, setLastQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);

  const [graphView, setGraphView] = useState<GraphView>("method");
  const [graphCache, setGraphCache] = useState<
    Partial<Record<GraphView, ResearchGraph>>
  >({});
  const [isGraphLoading, setIsGraphLoading] = useState(false);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(
    null,
  );
  const [selectedGraphEdgeId, setSelectedGraphEdgeId] = useState<string | null>(
    null,
  );
  const [selectedGraphNodeDetail, setSelectedGraphNodeDetail] =
    useState<ResearchGraphNodeDetail | null>(null);
  const [selectedGraphEdgeDetail, setSelectedGraphEdgeDetail] =
    useState<ResearchGraphEdgeDetail | null>(null);
  const [isGraphDetailLoading, setIsGraphDetailLoading] = useState(false);

  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [isReviewLoading, setIsReviewLoading] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [applyingCandidateId, setApplyingCandidateId] = useState<string | null>(
    null,
  );
  const [overrideLabels, setOverrideLabels] = useState<Record<string, string>>(
    {},
  );

  const [ideas, setIdeas] = useState<IdeaCandidate[]>([]);
  const [isIdeasLoading, setIsIdeasLoading] = useState(false);
  const [ideaNodeIndex, setIdeaNodeIndex] = useState<
    Record<string, IdeaCandidate>
  >({});
  const [ideaSourceIndex, setIdeaSourceIndex] = useState<
    Record<string, ResearchGraphNodeDetail>
  >({});
  const [selectedIdea, setSelectedIdea] = useState<IdeaCandidate | null>(null);
  const [ideaDraft, setIdeaDraft] = useState({ title: "", summary: "" });
  const [isIdeaEditing, setIsIdeaEditing] = useState(false);
  const [isIdeaSaving, setIsIdeaSaving] = useState(false);
  const [ideaSaveError, setIdeaSaveError] = useState<string | null>(null);
  const [isGraphCanvasOpen, setIsGraphCanvasOpen] = useState(false);
  const [moduleTooltip, setModuleTooltip] = useState<{
    nodeId: string;
    x: number;
    y: number;
    title: string;
    description?: string | null;
    evidence: EvidenceRef[];
  } | null>(null);
  const [hoveredGraphNodeId, setHoveredGraphNodeId] = useState<string | null>(
    null,
  );
  const [graphPulseTick, setGraphPulseTick] = useState(0);
  const [starGlyphs, setStarGlyphs] = useState<StarGraphGlyph[]>([]);
  const [starEdgeFlows, setStarEdgeFlows] = useState<StarGraphEdgeFlow[]>([]);
  const [enteredStarIds, setEnteredStarIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [spinningStarIds, setSpinningStarIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [neighborStarIds, setNeighborStarIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [dimmedStarIds, setDimmedStarIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isStarScrollOpen, setIsStarScrollOpen] = useState(false);
  const graphCanvasRef = useRef<HTMLDivElement | null>(null);
  const starDustCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cyRef = useRef<CytoscapeCore | null>(null);
  const selectedGraphNodeIdRef = useRef<string | null>(null);
  const starSyncFrameRef = useRef<number | null>(null);
  const starEntranceFrameRef = useRef<number | null>(null);
  const isStarDraggingRef = useRef(false);
  const starEntranceTimersRef = useRef<number[]>([]);
  const starSpinTimersRef = useRef<number[]>([]);

  const activeGraph = graphCache[graphView] ?? null;
  const orphanNodes = useMemo(
    () => (activeGraph?.nodes ?? []).filter((node) => node.isOrphan),
    [activeGraph],
  );
  const selectedIdeaLinkedNodes = useMemo(() => {
    if (!selectedIdea) return [];
    const links: Array<{ id: string; label: string; kind: GraphNodeKind }> = [];
    const pushLink = (id?: string | null) => {
      if (!id) return;
      const detail = ideaSourceIndex[id];
      const fallbackKind = resolveIdeaSourceKind(
        selectedIdea,
        id,
      ) as GraphNodeKind;
      const kind = (detail?.kind as GraphNodeKind | undefined) ?? fallbackKind;
      const label =
        detail?.label ??
        `${graphKindLabels[kind] ?? "Source"} ${id.slice(0, 6)}`;
      links.push({ id, label, kind });
    };
    pushLink(selectedIdea.challengeNodeId);
    pushLink(selectedIdea.taskNodeId);
    pushLink(selectedIdea.pipelineNodeId);
    pushLink(selectedIdea.moduleNodeId);
    return links;
  }, [ideaSourceIndex, selectedIdea]);

  function clearStarAnimationTimers() {
    starEntranceTimersRef.current.forEach((timer) =>
      window.clearTimeout(timer),
    );
    starEntranceTimersRef.current = [];
    starSpinTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    starSpinTimersRef.current = [];
    if (starEntranceFrameRef.current != null) {
      window.cancelAnimationFrame(starEntranceFrameRef.current);
      starEntranceFrameRef.current = null;
    }
    if (starSyncFrameRef.current != null) {
      window.cancelAnimationFrame(starSyncFrameRef.current);
      starSyncFrameRef.current = null;
    }
  }

  useEffect(() => {
    if (!isGraphCanvasOpen) return;
    let frameId = 0;
    let setupFrameId = 0;
    let disposed = false;
    const pointer = { x: -9999, y: -9999 };
    let particles: StarDustParticle[] = [];
    let lastFrameAt = 0;
    let host: HTMLElement | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let context: CanvasRenderingContext2D | null = null;

    const resize = () => {
      if (!host || !canvas || !context) return;
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.max(
        140,
        Math.min(280, Math.round((rect.width * rect.height) / 7600)),
      );
      particles = Array.from({ length: count }, () => {
        const x = Math.random() * rect.width;
        const y = Math.random() * rect.height;
        return {
          x,
          y,
          homeX: x,
          homeY: y,
          vx: (Math.random() - 0.5) * 0.08,
          vy: (Math.random() - 0.5) * 0.08,
          radius: 0.75 + Math.random() * 1.25,
          alpha: 0.3 + Math.random() * 0.62,
        };
      });
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
    };
    const handlePointerLeave = () => {
      pointer.x = -9999;
      pointer.y = -9999;
    };

    const tick = () => {
      if (disposed || !canvas || !context) return;
      const now = performance.now();
      if (now - lastFrameAt < 32) {
        frameId = window.requestAnimationFrame(tick);
        return;
      }
      lastFrameAt = now;
      const rect = canvas.getBoundingClientRect();
      context.clearRect(0, 0, rect.width, rect.height);
      context.globalCompositeOperation = "lighter";
      for (const particle of particles) {
        const dx = particle.x - pointer.x;
        const dy = particle.y - pointer.y;
        const distSq = dx * dx + dy * dy;
        const radius = 110;
        if (distSq > 0.001 && distSq < radius * radius) {
          const dist = Math.sqrt(distSq);
          const force = ((radius - dist) / radius) * 0.42;
          particle.vx += (dx / dist) * force;
          particle.vy += (dy / dist) * force;
        }
        particle.vx += (particle.homeX - particle.x) * 0.0022;
        particle.vy += (particle.homeY - particle.y) * 0.0022;
        particle.vx *= 0.92;
        particle.vy *= 0.92;
        particle.x += particle.vx;
        particle.y += particle.vy;

        const twinkle = 0.72 + Math.sin(now * 0.0015 + particle.homeX) * 0.28;
        context.beginPath();
        context.fillStyle = `rgba(224, 250, 255, ${particle.alpha * twinkle})`;
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fill();
        if (particle.radius > 1.25) {
          context.beginPath();
          context.fillStyle = `rgba(112, 224, 255, ${particle.alpha * 0.18 * twinkle})`;
          context.arc(
            particle.x,
            particle.y,
            particle.radius * 3.2,
            0,
            Math.PI * 2,
          );
          context.fill();
        }
      }
      context.globalCompositeOperation = "source-over";
      frameId = window.requestAnimationFrame(tick);
    };

    const setup = () => {
      canvas = starDustCanvasRef.current;
      host = canvas?.parentElement ?? graphCanvasRef.current;
      context = canvas?.getContext("2d") ?? null;
      if (!canvas || !host || !context) {
        setupFrameId = window.requestAnimationFrame(setup);
        return;
      }
      resize();
      host.addEventListener("pointermove", handlePointerMove);
      host.addEventListener("pointerleave", handlePointerLeave);
      window.addEventListener("resize", resize);
      frameId = window.requestAnimationFrame(tick);
    };
    setupFrameId = window.requestAnimationFrame(setup);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(setupFrameId);
      window.cancelAnimationFrame(frameId);
      host?.removeEventListener("pointermove", handlePointerMove);
      host?.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("resize", resize);
    };
  }, [isGraphCanvasOpen, activeGraph?.nodes.length, activeGraph?.edges.length]);

  function syncStarOverlayPositions() {
    const cy = cyRef.current;
    if (!cy) return;
    if (starSyncFrameRef.current != null) {
      window.cancelAnimationFrame(starSyncFrameRef.current);
    }
    starSyncFrameRef.current = window.requestAnimationFrame(() => {
      starSyncFrameRef.current = null;
      const canvasRect = graphCanvasRef.current?.getBoundingClientRect();
      const maxX = Math.max(126, (canvasRect?.width ?? 0) - 126);
      const maxY = Math.max(54, (canvasRect?.height ?? 0) - 54);
      const glyphs = cy
        .nodes(".graph-node")
        .map((node) => {
          const rendered = node.renderedPosition();
          return {
            id: node.id(),
            label: String(node.data("rawLabel") ?? node.data("label") ?? ""),
            kind: String(node.data("kind")) as GraphNodeKind,
            kindLabel: String(
              node.data("kindLabel") ?? node.data("kind") ?? "",
            ),
            x: Math.max(126, Math.min(maxX, rendered.x)),
            y: Math.max(54, Math.min(maxY, rendered.y)),
          };
        })
        .sort((left, right) =>
          left.x === right.x ? left.y - right.y : left.x - right.x,
        );
      setStarGlyphs(glyphs);
      const flows = cy
        .edges(".graph-edge")
        .map((edge) => {
          const from = edge.source().id();
          const to = edge.target().id();
          const source = edge.source().renderedPosition();
          const target = edge.target().renderedPosition();
          const deltaX = target.x - source.x;
          const deltaY = target.y - source.y;
          const curve = Math.max(60, Math.min(180, Math.abs(deltaX) * 0.36));
          const lift = Math.max(-90, Math.min(90, deltaY * 0.16));
          const c1x = source.x + curve;
          const c1y = source.y - lift;
          const c2x = target.x - curve;
          const c2y = target.y + lift;
          const edgeType = String(edge.data("edgeType") ?? "");
          const isIdea = edgeType === "inspired_by" || edgeType === "resolves";
          return {
            id: edge.id(),
            edgeType,
            label: edgeType,
            isIdea,
            from,
            to,
            d: `M ${source.x.toFixed(1)} ${source.y.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${target.x.toFixed(1)} ${target.y.toFixed(1)}`,
          };
        })
        .sort((left, right) => left.id.localeCompare(right.id));
      setStarEdgeFlows(flows);
    });
  }

  function syncStarOverlayDomPositions() {
    const cy = cyRef.current;
    const canvas = graphCanvasRef.current;
    if (!cy || !canvas) return;
    const canvasRect = canvas.getBoundingClientRect();
    const maxX = Math.max(126, canvasRect.width - 126);
    const maxY = Math.max(54, canvasRect.height - 54);
    for (const node of cy.nodes(".graph-node")) {
      const rendered = node.renderedPosition();
      const x = Math.max(126, Math.min(maxX, rendered.x));
      const y = Math.max(54, Math.min(maxY, rendered.y));
      const el = canvas.querySelector<HTMLElement>(
        `.star-glyph[data-node-id="${CSS.escape(node.id())}"]`,
      );
      if (el) {
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      }
    }
    for (const edge of cy.edges(".graph-edge")) {
      const source = edge.source().renderedPosition();
      const target = edge.target().renderedPosition();
      const deltaX = target.x - source.x;
      const deltaY = target.y - source.y;
      const curve = Math.max(60, Math.min(180, Math.abs(deltaX) * 0.36));
      const lift = Math.max(-90, Math.min(90, deltaY * 0.16));
      const d = `M ${source.x.toFixed(1)} ${source.y.toFixed(1)} C ${(source.x + curve).toFixed(1)} ${(source.y - lift).toFixed(1)}, ${(target.x - curve).toFixed(1)} ${(target.y + lift).toFixed(1)}, ${target.x.toFixed(1)} ${target.y.toFixed(1)}`;
      canvas
        .querySelectorAll<
          SVGPathElement | SVGCircleElement
        >(`[data-edge-id="${CSS.escape(edge.id())}"]`)
        .forEach((el) => {
          if (el instanceof SVGPathElement) {
            el.setAttribute("d", d);
            return;
          }
          const motion = el.querySelector("animateMotion");
          motion?.setAttribute("path", d);
        });
    }
  }

  function runStarEntranceAnimation() {
    const cy = cyRef.current;
    if (!cy) return;
    starEntranceTimersRef.current.forEach((timer) =>
      window.clearTimeout(timer),
    );
    starEntranceTimersRef.current = [];
    if (starEntranceFrameRef.current != null) {
      window.cancelAnimationFrame(starEntranceFrameRef.current);
      starEntranceFrameRef.current = null;
    }
    setEnteredStarIds(new Set());
    syncStarOverlayPositions();
    const orderedNodeIds = cy
      .nodes(".graph-node")
      .sort((left, right) => {
        const leftPosition = left.position();
        const rightPosition = right.position();
        return leftPosition.x === rightPosition.x
          ? leftPosition.y - rightPosition.y
          : leftPosition.x - rightPosition.x;
      })
      .map((node) => node.id());
    const startTimer = window.setTimeout(() => {
      const width =
        graphCanvasRef.current?.getBoundingClientRect().width ?? 1400;
      const orderedNodes = cy
        .nodes(".graph-node")
        .map((node) => ({
          id: node.id(),
          x: Math.max(0, Math.min(width, node.renderedPosition().x)),
        }))
        .sort((left, right) => left.x - right.x);
      if (orderedNodes.length === 0) return;
      const durationMs = 2300;
      const startAt = performance.now();
      const animate = (now: number) => {
        const progress = Math.min(1, (now - startAt) / durationMs);
        const sweepX = Math.max(0, Math.min(width, progress * width));
        const next = new Set(
          orderedNodes
            .filter((node) => node.x <= sweepX + 12)
            .map((node) => node.id),
        );
        setEnteredStarIds(next);
        if (progress < 1) {
          starEntranceFrameRef.current = window.requestAnimationFrame(animate);
        } else {
          setEnteredStarIds(new Set(orderedNodeIds));
          starEntranceFrameRef.current = null;
        }
      };
      starEntranceFrameRef.current = window.requestAnimationFrame(animate);
    }, 80);
    starEntranceTimersRef.current.push(startTimer);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        syncStarOverlayPositions();
      });
    });
  }

  function clearStarFocusState() {
    setNeighborStarIds(new Set());
    setDimmedStarIds(new Set());
  }

  function clearGraphCanvasSelection() {
    setSelectedGraphNodeId(null);
    setSelectedGraphEdgeId(null);
    setSelectedGraphNodeDetail(null);
    setSelectedGraphEdgeDetail(null);
    setSelectedIdea(null);
    setIsIdeaEditing(false);
    setIdeaSaveError(null);
    setHoveredGraphNodeId(null);
    setModuleTooltip(null);
    clearStarFocusState();
    cyRef.current
      ?.elements()
      .removeClass(
        "graph-selected graph-neighbor graph-dimmed graph-hovered graph-hover-edge",
      );
  }

  function syncStarFocusFromNode(nodeId: string) {
    const cy = cyRef.current;
    if (!cy) return;
    const node = cy.getElementById(nodeId);
    if (node.empty()) return;
    const neighborhood = node.closedNeighborhood().nodes(".graph-node");
    const neighborIds = new Set(neighborhood.map((item) => item.id()));
    const dimmedIds = new Set(
      cy
        .nodes(".graph-node")
        .filter((item) => !neighborIds.has(item.id()))
        .map((item) => item.id()),
    );
    setNeighborStarIds(neighborIds);
    setDimmedStarIds(dimmedIds);
  }

  function triggerStarTapAnimation(nodeId: string) {
    setSpinningStarIds((current) => {
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
    window.requestAnimationFrame(() => {
      setSpinningStarIds((current) => {
        const next = new Set(current);
        next.add(nodeId);
        return next;
      });
      const timer = window.setTimeout(() => {
        setSpinningStarIds((current) => {
          const next = new Set(current);
          next.delete(nodeId);
          return next;
        });
      }, 920);
      starSpinTimersRef.current.push(timer);
    });

    const node = cyRef.current?.getElementById(nodeId);
    if (node?.nonempty()) {
      const baseWidth = Number(node.style("width")) || 220;
      const baseHeight = Number(node.style("height")) || 84;
      node
        .animate(
          {
            style: {
              width: baseWidth + 24,
              height: baseHeight + 14,
              "underlay-opacity": 0,
              "underlay-padding": 0,
            },
          },
          { duration: 150, easing: "ease-out-cubic" },
        )
        .animate(
          {
            style: {
              width: baseWidth,
              height: baseHeight,
              "underlay-opacity": 0,
              "underlay-padding": 0,
            },
          },
          { duration: 360, easing: "ease-out-cubic" },
        );
    }
  }

  function beginStarGlyphDrag(
    event: React.PointerEvent<HTMLDivElement>,
    nodeId: string,
  ) {
    const cy = cyRef.current;
    const node = cy?.getElementById(nodeId);
    if (!cy || !node || node.empty()) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = node.renderedPosition();
    const canvasRect = graphCanvasRef.current?.getBoundingClientRect();
    const maxX = Math.max(126, (canvasRect?.width ?? 0) - 126);
    const maxY = Math.max(54, (canvasRect?.height ?? 0) - 54);
    const wasUserPanningEnabled = cy.userPanningEnabled();
    cy.userPanningEnabled(false);
    syncStarFocusFromNode(nodeId);
    isStarDraggingRef.current = true;
    target.classList.add("is-dragging");

    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const nextX = Math.max(
        126,
        Math.min(maxX, startPosition.x + moveEvent.clientX - startX),
      );
      const nextY = Math.max(
        54,
        Math.min(maxY, startPosition.y + moveEvent.clientY - startY),
      );
      target.style.left = `${nextX}px`;
      target.style.top = `${nextY}px`;
      node.renderedPosition({ x: nextX, y: nextY });
      syncStarOverlayDomPositions();
      syncModuleTooltipPosition();
    };

    const finishDrag = () => {
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("pointerup", finishDrag, true);
      document.removeEventListener("pointercancel", finishDrag, true);
      target.classList.remove("is-dragging");
      cy.userPanningEnabled(wasUserPanningEnabled);
      isStarDraggingRef.current = false;
      syncStarOverlayPositions();
      syncModuleTooltipPosition();
    };

    document.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("pointerup", finishDrag, {
      once: true,
      capture: true,
    });
    document.addEventListener("pointercancel", finishDrag, {
      once: true,
      capture: true,
    });
  }

  const reviewCounts = useMemo(() => {
    const counts: Record<ReviewFilter, number> = {
      all: reviews.length,
      task: 0,
      pipeline: 0,
      module: 0,
      challenge: 0,
      insight: 0,
      edge: 0,
    };
    for (const review of reviews) {
      if (review.candidateKind === "edge") {
        counts.edge += 1;
        continue;
      }
      const kind = review.entityKind as ReviewFilter | null | undefined;
      if (kind && kind in counts) {
        counts[kind] += 1;
      }
    }
    return counts;
  }, [reviews]);
  const filteredReviews = useMemo(() => {
    if (reviewFilter === "all") {
      return reviews;
    }
    if (reviewFilter === "edge") {
      return reviews.filter((review) => review.candidateKind === "edge");
    }
    return reviews.filter(
      (review) =>
        review.candidateKind === "node" && review.entityKind === reviewFilter,
    );
  }, [reviewFilter, reviews]);
  const diagnosticsByPaperId = useMemo(() => {
    return new Map(diagnostics.map((record) => [record.paperId, record]));
  }, [diagnostics]);
  const ingestStageLabel = useMemo(() => {
    if (!ingestProgress?.stage) return "idle";
    const labels: Record<string, string> = {
      prepare_ingest: "准备导入",
      prepare_models: "检查模型",
      scan: "扫描文件",
      parse_pages: "解析页面",
      candidate_extract: "抽取候选概念",
      pipeline_summarize: "总结 Pipeline 骨架",
      pipeline_name_extract: "提取 Pipeline 名称",
      edge_extract: "抽取 Edge",
      edge_validate: "校验 Edge",
      canonicalize: "归并候选概念",
      index_vectors: "重建向量索引",
      finalize: "保存索引",
    };
    return labels[ingestProgress.stage] || ingestProgress.stage;
  }, [ingestProgress]);

  useEffect(() => {
    if (activeTab === "papers" && papers.length === 0) {
      void loadPapers();
    }
    if (activeTab === "graph" && !graphCache[graphView]) {
      void loadGraph(graphView);
    }
    if (activeTab === "review" && reviews.length === 0) {
      void loadReviews();
    }
    if (activeTab === "ideas" && ideas.length === 0) {
      void loadIdeas();
    }
  }, [
    activeTab,
    graphCache,
    graphView,
    ideas.length,
    papers.length,
    reviews.length,
  ]);

  useEffect(() => {
    if (graphView === "idea") return;
    setSelectedIdea(null);
    setIsIdeaEditing(false);
    setIdeaSaveError(null);
  }, [graphView]);

  useEffect(() => {
    if (!isGraphCanvasOpen || !graphCanvasRef.current || !activeGraph) return;

    const usePresetLayout = activeGraph.edges.length === 0;
    clearStarAnimationTimers();
    setIsStarScrollOpen(false);
    setStarGlyphs([]);
    setStarEdgeFlows([]);
    setEnteredStarIds(new Set());
    setSpinningStarIds(new Set());
    clearStarFocusState();

    const cy = cytoscape({
      container: graphCanvasRef.current,
      elements: buildGraphElements(activeGraph, graphView),
      autoungrabify: false,
      boxSelectionEnabled: false,
      maxZoom: 5.6,
      minZoom: 0.35,
      wheelSensitivity: 0.5,
      style: [
        {
          selector: "core",
          style: {
            "active-bg-opacity": 0,
            "selection-box-opacity": 0,
            "outside-texture-bg-color": "#07111f",
            "outside-texture-bg-opacity": 1,
          } as any,
        },
        {
          selector: "node.graph-anchor",
          style: {
            opacity: 0,
            width: 1,
            height: 1,
            events: "no",
            label: "",
          },
        },
        {
          selector: "edge.graph-anchor-edge",
          style: {
            opacity: 0,
            width: 1,
            events: "no",
          },
        },
        {
          selector: "node.graph-node",
          style: {
            shape: "round-rectangle",
            width: "220px",
            height: "86px",
            padding: "0px",
            label: "",
            "text-wrap": "none",
            "text-max-width": 1,
            color: "transparent",
            "font-size": 1,
            "font-weight": 400,
            "text-valign": "center",
            "text-halign": "center",
            "background-color": "rgba(12, 28, 54, 0.01)",
            "border-width": 0,
            "border-color": "transparent",
            "background-opacity": 0.01,
            "overlay-opacity": 0,
            "underlay-opacity": 0,
            "underlay-padding": 0,
            "underlay-color": "rgba(102, 218, 255, 0.34)",
            "text-outline-width": 0,
            "shadow-blur": 0,
            "shadow-color": "transparent",
            "shadow-opacity": 0,
            "shadow-offset-x": 0,
            "shadow-offset-y": 0,
          },
        },
        {
          selector: "node.graph-node-orphan",
          style: {
            "underlay-color": "rgba(255, 205, 139, 0.28)",
          },
        },
        {
          selector: "node.graph-node-task",
          style: {
            "underlay-color": "rgba(255, 163, 91, 0.34)",
          },
        },
        {
          selector: "node.graph-node-pipeline",
          style: {
            "underlay-color": "rgba(89, 193, 255, 0.3)",
          },
        },
        {
          selector: "node.graph-node-module",
          style: {
            "underlay-color": "rgba(77, 224, 167, 0.3)",
          },
        },
        {
          selector: "node.graph-node-idea",
          style: {
            "underlay-color": "rgba(251, 191, 36, 0.32)",
          },
        },
        {
          selector:
            "node.graph-node-task.graph-selected, node.graph-node-task.graph-hovered",
          style: {
            "underlay-color": "rgba(255, 173, 104, 0.42)",
          },
        },
        {
          selector:
            "node.graph-node-pipeline.graph-selected, node.graph-node-pipeline.graph-hovered",
          style: {
            "underlay-color": "rgba(116, 219, 255, 0.42)",
          },
        },
        {
          selector:
            "node.graph-node-module.graph-selected, node.graph-node-module.graph-hovered",
          style: {
            "underlay-color": "rgba(104, 235, 186, 0.4)",
          },
        },
        {
          selector:
            "node.graph-node-idea.graph-selected, node.graph-node-idea.graph-hovered",
          style: {
            "underlay-color": "rgba(251, 191, 36, 0.44)",
          },
        },
        {
          selector: "edge.graph-edge",
          style: {
            width: 0,
            "curve-style": "unbundled-bezier",
            "control-point-distances": 42,
            "control-point-weights": 0.5,
            "line-color": "transparent",
            "target-arrow-color": "transparent",
            "target-arrow-shape": "vee",
            "arrow-scale": 0,
            opacity: 0,
            "line-style": "solid",
            "shadow-blur": 2,
            "shadow-color": "rgba(94, 212, 255, 0.28)",
            "shadow-opacity": 0,
            "shadow-offset-x": 0,
            "shadow-offset-y": 0,
          },
        },
        {
          selector: ".graph-dimmed",
          style: {
            opacity: 0.1,
          },
        },
        {
          selector: "node.graph-selected",
          style: {
            "underlay-opacity": 0,
            "underlay-padding": 0,
          },
        },
        {
          selector: "edge.graph-selected",
          style: {
            width: 0,
            opacity: 0,
            "line-color": "transparent",
            "target-arrow-color": "transparent",
            "arrow-scale": 0,
            "shadow-blur": 7,
            "shadow-color": "rgba(128, 226, 255, 0.46)",
            "shadow-opacity": 0,
          },
        },
        {
          selector: "node.graph-neighbor",
          style: {
            opacity: 1,
            "underlay-opacity": 0,
            "underlay-padding": 0,
          },
        },
        {
          selector: "node.graph-hovered",
          style: {
            "underlay-opacity": 0,
            "underlay-padding": 0,
          },
        },
        {
          selector: "edge.graph-hover-edge",
          style: {
            width: 0,
            opacity: 0,
            "line-color": "transparent",
            "target-arrow-color": "transparent",
            "arrow-scale": 0,
            "line-style": "solid",
            "shadow-blur": 8,
            "shadow-color": "rgba(137, 228, 255, 0.52)",
            "shadow-opacity": 0,
          },
        },
      ] as any,
    });

    cyRef.current = cy;
    cy.nodes(".graph-anchor").ungrabify();
    cy.nodes(".graph-node").grabify();
    cy.edges(".graph-edge").style({
      width: 0,
      opacity: 0,
      "line-color": "transparent",
      "target-arrow-color": "transparent",
      "arrow-scale": 0,
      "shadow-opacity": 0,
    });

    const clearHoverClasses = () => {
      cy.elements().removeClass(
        "graph-hovered graph-hover-edge graph-neighbor graph-dimmed",
      );
    };

    cy.on("tap", "node.graph-node", (event) => {
      const node = event.target;
      triggerStarTapAnimation(node.id());
      syncStarFocusFromNode(node.id());
      void handleSelectGraphNode(node.id());
    });

    cy.on("tap", "edge.graph-edge", (event) => {
      if (graphView === "idea") return;
      const edge = event.target;
      void handleSelectGraphEdge(edge.id());
    });

    cy.on("mouseover", "edge.graph-edge", () => {
      cy.userPanningEnabled(false);
    });

    cy.on("mouseout", "edge.graph-edge", () => {
      cy.userPanningEnabled(true);
    });

    cy.on("tap", (event) => {
      if (event.target !== cy) return;
      clearGraphCanvasSelection();
    });

    cy.on("mouseover", "node.graph-node", (event) => {
      const node = event.target;
      setHoveredGraphNodeId(node.id());
      syncStarFocusFromNode(node.id());
      clearHoverClasses();
      const neighborhood = node.closedNeighborhood().union(node);
      cy.nodes(".graph-node")
        .not(neighborhood.nodes())
        .addClass("graph-dimmed");
      cy.edges(".graph-edge")
        .not(neighborhood.edges())
        .addClass("graph-dimmed");
      node.addClass("graph-hovered");
      neighborhood.nodes().not(node).addClass("graph-neighbor");
      neighborhood.edges().addClass("graph-hover-edge");
    });

    cy.on("mouseout", "node.graph-node", () => {
      setHoveredGraphNodeId(null);
      if (selectedGraphNodeIdRef.current) {
        syncStarFocusFromNode(selectedGraphNodeIdRef.current);
      } else {
        clearStarFocusState();
      }
      clearHoverClasses();
      applyGraphSelectionState();
    });

    cy.on("zoom pan render resize", () => {
      if (isStarDraggingRef.current) {
        syncStarOverlayDomPositions();
        return;
      }
      syncStarOverlayPositions();
      syncModuleTooltipPosition();
    });

    cy.on("grab drag free position", "node.graph-node", () => {
      if (isStarDraggingRef.current) {
        syncStarOverlayDomPositions();
        return;
      }
      syncStarOverlayPositions();
      syncModuleTooltipPosition();
    });

    const revealGraph = () => {
      window.requestAnimationFrame(() => {
        resetGraphView();
        applyGraphSelectionState();
        syncModuleTooltipPosition();
        window.setTimeout(() => {
          setIsStarScrollOpen(true);
          runStarEntranceAnimation();
        }, 120);
        const edgeTimer = window.setTimeout(
          () => {
            cy.edges(".graph-edge").animate(
              { style: { opacity: 0 } },
              { duration: 460, easing: "ease-out-cubic" },
            );
          },
          Math.min(2450, Math.max(820, activeGraph.nodes.length * 95)),
        );
        starEntranceTimersRef.current.push(edgeTimer);
      });
    };

    const runPresetFallback = () => {
      cy.one("layoutstop", revealGraph);
      cy.layout({
        name: "preset",
        fit: true,
        padding: 80,
        animate: false,
      } as any).run();
    };

    cy.one("layoutstop", () => {
      if (!usePresetLayout && shouldFallbackToPresetLayout(cy)) {
        runPresetFallback();
        return;
      }
      revealGraph();
    });
    cy.layout({
      name: usePresetLayout ? "preset" : "dagre",
      rankDir: "LR",
      nodeSep: graphView === "idea" ? 70 : 54,
      edgeSep: 26,
      rankSep:
        graphView === "method" ? 210 : graphView === "problem" ? 240 : 260,
      animate: false,
      fit: true,
      padding: 76,
      ranker: "tight-tree",
    } as any).run();

    return () => {
      clearStarAnimationTimers();
      setIsStarScrollOpen(false);
      setStarGlyphs([]);
      setStarEdgeFlows([]);
      setEnteredStarIds(new Set());
      setSpinningStarIds(new Set());
      clearStarFocusState();
      cy.destroy();
      cyRef.current = null;
    };
  }, [activeGraph, graphView, isGraphCanvasOpen]);

  useEffect(() => {
    selectedGraphNodeIdRef.current = selectedGraphNodeId;
    applyGraphSelectionState();
    if (selectedGraphNodeId) {
      syncStarFocusFromNode(selectedGraphNodeId);
    } else if (!hoveredGraphNodeId) {
      clearStarFocusState();
    }
  }, [selectedGraphEdgeId, selectedGraphNodeId]);

  useEffect(() => {
    syncModuleTooltipPosition();
  }, [moduleTooltip?.nodeId]);

  useEffect(() => {
    if (!hoveredGraphNodeId) return;
    const timer = window.setInterval(() => {
      setGraphPulseTick((current) => current + 1);
    }, 520);
    return () => window.clearInterval(timer);
  }, [hoveredGraphNodeId]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const hoveredNodeId = hoveredGraphNodeId;
    if (!hoveredNodeId) return;
    const edges = cy
      .getElementById(hoveredNodeId)
      .connectedEdges(".graph-hover-edge");
    if (edges.empty()) return;
    const pulseWidth = graphPulseTick % 2 === 0 ? 6 : 8;
    const pulseOffset = graphPulseTick % 2 === 0 ? 0 : -6;
    edges.style({
      width: pulseWidth,
      "line-dash-offset": pulseOffset,
    });
  }, [graphPulseTick, hoveredGraphNodeId]);

  async function loadPapers(force = false) {
    if (!force && papers.length > 0) return;
    setIsPapersLoading(true);
    if (force) {
      onStatus?.("正在刷新论文状态视图，不会重置审核结果。", "info");
    }
    try {
      const [records, extractionDiagnostics] = await Promise.all([
        invoke<ResearchPaperRecord[]>("list_research_papers"),
        invoke<ResearchExtractionDiagnosticsRecord[]>(
          "list_research_extraction_diagnostics",
        ),
      ]);
      setPapers(records);
      setDiagnostics(extractionDiagnostics);
    } catch (error) {
      onStatus?.(`加载论文状态失败：${String(error)}`, "error");
    } finally {
      setIsPapersLoading(false);
    }
  }

  async function loadGraph(view: GraphView, force = false) {
    if (view === "idea") {
      await loadIdeaGraph(force);
      return;
    }
    if (!force && graphCache[view]) return;
    setIsGraphLoading(true);
    if (force) {
      onStatus?.("正在刷新图谱视图，不会重置审核结果。", "info");
    }
    try {
      const graph = await invoke<ResearchGraph>("get_research_graph", { view });
      setGraphCache((current) => ({ ...current, [view]: graph }));
      setSelectedGraphNodeId(null);
      setSelectedGraphEdgeId(null);
      setSelectedGraphNodeDetail(null);
      setSelectedGraphEdgeDetail(null);
      setModuleTooltip(null);
    } catch (error) {
      onStatus?.(`加载图谱失败：${String(error)}`, "error");
    } finally {
      setIsGraphLoading(false);
    }
  }

  async function loadIdeaGraph(force = false) {
    if (!force && graphCache.idea) return;
    setIsGraphLoading(true);
    if (force) {
      onStatus?.("正在刷新 Idea 图谱视图，不会重置审核结果。", "info");
    }
    try {
      const records =
        ideas.length > 0 && !force
          ? ideas
          : await invoke<IdeaCandidate[]>("list_idea_candidates");
      if (ideas.length === 0 || force) {
        setIdeas(records);
      }

      const sourceIds = new Set<string>();
      records.forEach((idea) => {
        if (idea.challengeNodeId) sourceIds.add(idea.challengeNodeId);
        if (idea.moduleNodeId) sourceIds.add(idea.moduleNodeId);
        if (idea.taskNodeId) sourceIds.add(idea.taskNodeId);
        if (idea.pipelineNodeId) sourceIds.add(idea.pipelineNodeId);
      });

      const sourceEntries = await Promise.all(
        Array.from(sourceIds).map(async (nodeId) => {
          try {
            const detail = await invoke<ResearchGraphNodeDetail>(
              "get_research_graph_node_detail",
              { nodeId },
            );
            return [nodeId, detail] as const;
          } catch {
            return null;
          }
        }),
      );

      const sourceIndex: Record<string, ResearchGraphNodeDetail> = {};
      sourceEntries.forEach((entry) => {
        if (!entry) return;
        sourceIndex[entry[0]] = entry[1];
      });
      setIdeaSourceIndex(sourceIndex);

      const ideaIndex: Record<string, IdeaCandidate> = {};
      const nodesById = new Map<string, ResearchGraphNode>();
      const edges: ResearchGraphEdge[] = [];

      records.forEach((idea) => {
        const nodeId = ideaNodeId(idea.id);
        ideaIndex[nodeId] = idea;
        const ideaNode: ResearchGraphNode = {
          id: nodeId,
          kind: "idea",
          label: idea.title,
          aliases: [],
          paperCount: 0,
          supportCount: Math.round(idea.confidence * 100),
          inDegree: 0,
          outDegree: 0,
          isOrphan: true,
        };
        nodesById.set(nodeId, ideaNode);

        const sourceLinks = [
          idea.challengeNodeId,
          idea.moduleNodeId,
          idea.taskNodeId,
          idea.pipelineNodeId,
        ].filter(Boolean) as string[];

        sourceLinks.forEach((sourceId) => {
          const detail = sourceIndex[sourceId];
          const fallbackKind = resolveIdeaSourceKind(
            idea,
            sourceId,
          ) as GraphNodeKind;
          const kind =
            (detail?.kind as GraphNodeKind | undefined) ?? fallbackKind;
          const label =
            detail?.label ??
            `${graphKindLabels[kind] ?? "Source"} ${sourceId.slice(0, 6)}`;
          if (!nodesById.has(sourceId)) {
            nodesById.set(sourceId, {
              id: sourceId,
              kind,
              label,
              aliases: detail?.aliases ?? [],
              paperCount: detail?.relatedPapers?.length ?? 0,
              supportCount: detail?.supportCount ?? 0,
              inDegree: 0,
              outDegree: 0,
              isOrphan: false,
            });
          }
          edges.push({
            id: `idea_edge_${sourceId}_${idea.id}`,
            edgeType: ideaEdgeTypeForKind(kind),
            from: sourceId,
            to: nodeId,
            supportCount: detail?.supportCount ?? 0,
          });
          ideaNode.isOrphan = false;
        });
      });

      const ideaGraph: ResearchGraph = {
        view: "idea",
        nodes: Array.from(nodesById.values()),
        edges,
      };

      setIdeaNodeIndex(ideaIndex);
      setGraphCache((current) => ({ ...current, idea: ideaGraph }));
      setSelectedGraphNodeId(null);
      setSelectedGraphEdgeId(null);
      setSelectedGraphNodeDetail(null);
      setSelectedGraphEdgeDetail(null);
      setSelectedIdea(null);
      setIsIdeaEditing(false);
      setIdeaSaveError(null);
      setModuleTooltip(null);
    } catch (error) {
      onStatus?.(`加载 Idea 图谱失败：${String(error)}`, "error");
    } finally {
      setIsGraphLoading(false);
    }
  }

  async function handleSelectGraphNode(nodeId: string) {
    const idea = graphView === "idea" ? ideaNodeIndex[nodeId] : null;
    if (idea) {
      setSelectedIdea(idea);
      setIdeaDraft({ title: idea.title, summary: idea.summary });
      setIsIdeaEditing(false);
      setIdeaSaveError(null);
      setSelectedGraphNodeId(nodeId);
      setSelectedGraphEdgeId(null);
      setSelectedGraphNodeDetail(null);
      setSelectedGraphEdgeDetail(null);
      setModuleTooltip(null);
      setIsGraphDetailLoading(false);
      return;
    }
    setSelectedGraphNodeId(nodeId);
    setSelectedIdea(null);
    setIsIdeaEditing(false);
    setIdeaSaveError(null);
    setSelectedGraphEdgeId(null);
    setSelectedGraphEdgeDetail(null);
    setModuleTooltip(null);
    setIsGraphDetailLoading(true);
    try {
      const detail = await invoke<ResearchGraphNodeDetail>(
        "get_research_graph_node_detail",
        { nodeId },
      );
      setSelectedGraphNodeDetail(detail);
      if (detail.kind === "module") {
        const node = cyRef.current?.getElementById(nodeId);
        const containerRect = graphCanvasRef.current?.getBoundingClientRect();
        if (node?.nonempty() && containerRect) {
          const rendered = node.renderedPosition();
          setModuleTooltip({
            nodeId,
            x: Math.min(rendered.x + 28, containerRect.width - 320),
            y: Math.max(18, rendered.y - 14),
            title: detail.label,
            description: detail.description,
            evidence: detail.evidence.slice(0, 3),
          });
        }
      }
    } catch (error) {
      setSelectedGraphNodeDetail(null);
      setModuleTooltip(null);
      onStatus?.(`加载节点详情失败：${String(error)}`, "error");
    } finally {
      setIsGraphDetailLoading(false);
    }
  }

  async function handleSelectGraphEdge(edgeId: string) {
    if (graphView === "idea") {
      setSelectedGraphEdgeId(null);
      setSelectedGraphNodeId(null);
      setSelectedGraphNodeDetail(null);
      setSelectedGraphEdgeDetail(null);
      setSelectedIdea(null);
      setIsIdeaEditing(false);
      setIdeaSaveError(null);
      setModuleTooltip(null);
      setIsGraphDetailLoading(false);
      return;
    }
    setSelectedGraphEdgeId(edgeId);
    setSelectedGraphNodeId(null);
    setSelectedGraphNodeDetail(null);
    setSelectedIdea(null);
    setIsIdeaEditing(false);
    setIdeaSaveError(null);
    setModuleTooltip(null);
    setIsGraphDetailLoading(true);
    try {
      const detail = await invoke<ResearchGraphEdgeDetail>(
        "get_research_graph_edge_detail",
        { edgeId },
      );
      setSelectedGraphEdgeDetail(detail);
    } catch (error) {
      setSelectedGraphEdgeDetail(null);
      onStatus?.(`加载边详情失败：${String(error)}`, "error");
    } finally {
      setIsGraphDetailLoading(false);
    }
  }

  async function loadReviews(force = false) {
    if (!force && reviews.length > 0) return;
    setIsReviewLoading(true);
    if (force) {
      onStatus?.(
        "正在刷新审核队列视图，不会重置审核结果；如有缺失 edge，会尝试自动补回。",
        "info",
      );
    }
    try {
      const records = await invoke<ReviewRecord[]>("list_extraction_reviews");
      setReviews(records);
    } catch (error) {
      onStatus?.(`加载审核队列失败：${String(error)}`, "error");
    } finally {
      setIsReviewLoading(false);
    }
  }

  async function loadIdeas(force = false) {
    if (!force && ideas.length > 0) return;
    setIsIdeasLoading(true);
    if (force) {
      onStatus?.("正在刷新 Idea 视图，不会重置审核结果。", "info");
    }
    try {
      const records = await invoke<IdeaCandidate[]>("list_idea_candidates");
      setIdeas(records);
    } catch (error) {
      onStatus?.(`加载 Idea 候选失败：${String(error)}`, "error");
    } finally {
      setIsIdeasLoading(false);
    }
  }

  function beginIdeaEdit() {
    if (!selectedIdea) return;
    setIdeaDraft({ title: selectedIdea.title, summary: selectedIdea.summary });
    setIsIdeaEditing(true);
    setIdeaSaveError(null);
  }

  function cancelIdeaEdit() {
    if (selectedIdea) {
      setIdeaDraft({
        title: selectedIdea.title,
        summary: selectedIdea.summary,
      });
    }
    setIsIdeaEditing(false);
    setIdeaSaveError(null);
  }

  async function saveIdeaEdit() {
    if (!selectedIdea) return;
    const title = ideaDraft.title.trim();
    const summary = ideaDraft.summary.trim();
    if (!title || !summary) {
      setIdeaSaveError("标题和摘要不能为空。");
      return;
    }
    setIsIdeaSaving(true);
    setIdeaSaveError(null);
    try {
      const updated = await invoke<IdeaCandidate>("update_idea_candidate", {
        ideaId: selectedIdea.id,
        title,
        summary,
      });
      setSelectedIdea(updated);
      setIdeas((current) =>
        current.map((idea) => (idea.id === updated.id ? updated : idea)),
      );
      const nodeId = ideaNodeId(updated.id);
      setIdeaNodeIndex((current) => ({ ...current, [nodeId]: updated }));
      setGraphCache((current) => {
        const ideaGraph = current.idea;
        if (!ideaGraph) return current;
        const nodes = ideaGraph.nodes.map((node) =>
          node.id === nodeId ? { ...node, label: updated.title } : node,
        );
        return { ...current, idea: { ...ideaGraph, nodes } };
      });
      setIsIdeaEditing(false);
    } catch (error) {
      setIdeaSaveError(`保存失败：${String(error)}`);
    } finally {
      setIsIdeaSaving(false);
    }
  }

  function applyGraphSelectionState() {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("graph-selected graph-neighbor graph-dimmed");
    const visibleNodes = cy.nodes(".graph-node");
    const visibleEdges = cy.edges(".graph-edge");
    if (selectedGraphNodeId) {
      const node = cy.getElementById(selectedGraphNodeId);
      if (node.nonempty()) {
        const neighborhood = node.closedNeighborhood().union(node);
        visibleNodes.not(neighborhood.nodes()).addClass("graph-dimmed");
        visibleEdges.not(neighborhood.edges()).addClass("graph-dimmed");
        node.addClass("graph-selected");
        neighborhood.nodes().not(node).addClass("graph-neighbor");
        neighborhood.edges().addClass("graph-selected");
      }
      return;
    }
    if (selectedGraphEdgeId) {
      const edge = cy.getElementById(selectedGraphEdgeId);
      if (edge.nonempty()) {
        const connected = edge.connectedNodes().union(edge);
        visibleNodes.not(connected.nodes()).addClass("graph-dimmed");
        visibleEdges.not(edge).addClass("graph-dimmed");
        connected.nodes().addClass("graph-neighbor");
        edge.addClass("graph-selected");
      }
    }
  }

  function syncModuleTooltipPosition() {
    const cy = cyRef.current;
    if (!cy) return;
    setModuleTooltip((current) => {
      if (!current) return null;
      const node = cy.getElementById(current.nodeId);
      const containerRect = graphCanvasRef.current?.getBoundingClientRect();
      if (!node.nonempty() || !containerRect) return current;
      const rendered = node.renderedPosition();
      return {
        ...current,
        x: Math.min(rendered.x + 28, containerRect.width - 320),
        y: Math.max(18, rendered.y - 14),
      };
    });
  }

  function zoomGraphBy(multiplier: number) {
    const cy = cyRef.current;
    if (!cy) return;
    const currentZoom = cy.zoom();
    const nextZoom = Math.max(0.35, Math.min(5.6, currentZoom * multiplier));
    cy.zoom({
      level: nextZoom,
      renderedPosition: {
        x: cy.width() / 2,
        y: cy.height() / 2,
      },
    });
    syncModuleTooltipPosition();
  }

  function fitGraphView() {
    const cy = cyRef.current;
    if (!cy) return;
    cy.fit(cy.elements(".graph-node, .graph-edge"), 80);
    syncModuleTooltipPosition();
  }

  function resetGraphView() {
    const cy = cyRef.current;
    if (!cy || !activeGraph) return;
    cy.fit(cy.elements(".graph-node, .graph-edge"), 80);
    if (activeGraph.nodes.length <= 2) {
      cy.zoom({
        level: Math.min(2.2, cy.zoom() * 1.85),
        renderedPosition: {
          x: cy.width() / 2,
          y: cy.height() / 2,
        },
      });
    }
    syncModuleTooltipPosition();
  }

  async function handleSearch() {
    const query = searchQuery.trim();
    if (!query) return;
    setIsSearching(true);
    setLastQuery(query);
    try {
      const results = await invoke<ResearchSearchHit[]>(
        "search_research_memory",
        {
          query,
          limit: 8,
        },
      );
      setSearchResults(results);
    } catch (error) {
      setSearchResults([]);
      onStatus?.(`检索论文记忆失败：${String(error)}`, "error");
    } finally {
      setIsSearching(false);
    }
  }

  async function handleDecision(
    review: ReviewRecord,
    decision: "approve" | "reject",
  ) {
    setApplyingCandidateId(review.candidateId);
    try {
      const overrideLabel = overrideLabels[review.candidateId]?.trim();
      await invoke<number>("apply_extraction_review", {
        request: {
          decisions: [
            {
              candidateId: review.candidateId,
              decision,
              overrideLabel: overrideLabel ? overrideLabel : null,
            },
          ],
        },
      });
      setReviews((current) =>
        current.filter((item) => item.candidateId !== review.candidateId),
      );
      setGraphCache({});
      setIdeas([]);
      setPapers([]);
      onStatus?.(
        decision === "approve" ? "已批准候选并重建图谱索引。" : "已拒绝候选。",
        "info",
      );
      void loadPapers(true);
      void loadGraph(graphView, true);
      void loadIdeas(true);
    } catch (error) {
      onStatus?.(`提交审核失败：${String(error)}`, "error");
    } finally {
      setApplyingCandidateId(null);
    }
  }

  async function handleOpenFile(path: string, page?: number, snippet?: string) {
    if (onOpenPathInApp) {
      onOpenPathInApp(path, page, snippet);
      return;
    }
    onStatus?.("当前未接入应用内定位打开。", "error");
  }

  const searchBody = (
    <>
      <div className="research-toolbar">
        <input
          className="research-text-input"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleSearch();
            }
          }}
          placeholder="Search by task, challenge, module, evidence..."
        />
        <button
          className="action-button"
          onClick={() => void handleSearch()}
          disabled={isSearching || !searchQuery.trim()}
        >
          {isSearching ? "Searching" : "Search"}
        </button>
      </div>

      {!lastQuery && !isSearching && (
        <div className="support-empty">输入关键词后检索可溯源论文片段。</div>
      )}
      {lastQuery && !isSearching && searchResults.length === 0 && (
        <div className="support-empty">没有找到相关证据。</div>
      )}
      {searchResults.map((hit) => (
        <div key={hit.id} className="research-card">
          <div className="research-card-head">
            <strong>{hit.title}</strong>
            <span className="research-chip">{scoreLabel(hit.score)}</span>
          </div>
          <div className="research-meta-row">
            <span>{pageLabel(hit.pageStart, hit.pageEnd)}</span>
            <span>{hit.relatedGraphNodes.length} graph refs</span>
          </div>
          <div className="support-item-text">{trimText(hit.snippet, 260)}</div>
          {hit.relatedGraphNodes.length > 0 && (
            <div className="research-tag-row">
              {hit.relatedGraphNodes.slice(0, 6).map((node) => (
                <span key={node} className="research-tag">
                  {node}
                </span>
              ))}
            </div>
          )}
          <div className="support-item-actions">
            <button
              className="action-button"
              onClick={() =>
                void handleOpenFile(hit.path, hit.pageStart, hit.snippet)
              }
            >
              Open file
            </button>
          </div>
        </div>
      ))}
    </>
  );

  const papersBody = (
    <>
      <div className="research-toolbar split">
        <div className="research-section-title tight">Paper Status</div>
        <button
          className="action-button"
          onClick={() => void loadPapers(true)}
          disabled={isPapersLoading}
          title="重新读取论文状态，不会重置审核结果"
        >
          {isPapersLoading ? "刷新中..." : "刷新视图"}
        </button>
      </div>
      {papers.length === 0 && !isPapersLoading && (
        <div className="support-empty">还没有已索引论文记录。</div>
      )}
      {papers.map((paper) => {
        const diagnostic = diagnosticsByPaperId.get(paper.paperId);
        return (
          <div key={paper.paperId} className="research-card">
            <div className="research-card-head">
              <strong>{paper.title}</strong>
              <span
                className={`research-chip ${paper.isInGraph ? "success" : ""}`}
              >
                {paperStatusLabels[paper.parseStatus] ?? paper.parseStatus}
              </span>
            </div>
            <div className="research-meta-row">
              <span>type</span>
              <span>{paperTypeLabels[paper.paperType] ?? paper.paperType}</span>
            </div>
            <div className="research-meta-row">
              <span>chunk</span>
              <span>{paper.chunkCount}</span>
            </div>
            <div className="research-meta-row">
              <span>候选</span>
              <span>{paper.candidateCount}</span>
            </div>
            <div className="research-meta-row">
              <span>待审核</span>
              <span>{paper.pendingReviewCount}</span>
            </div>
            <div className="research-meta-row">
              <span>已入图</span>
              <span>
                {paper.isInGraph
                  ? `是 (${paper.approvedCandidateCount})`
                  : "否"}
              </span>
            </div>
            <div className="research-meta-row">
              <span>index / extraction</span>
              <span>
                {paper.indexStatus} / {paper.extractionStatus}
              </span>
            </div>
            {diagnostic && (
              <>
                <div className="research-meta-row">
                  <span>relation units</span>
                  <span>{diagnostic.relationMapUnitCount}</span>
                </div>
                <div className="research-meta-row">
                  <span>candidate 冲突</span>
                  <span>{diagnostic.candidateConflictCount}</span>
                </div>
                <div className="research-meta-row">
                  <span>pipeline 空 summary / 空命名</span>
                  <span>
                    {diagnostic.pipelineSummaryEmptyCount} /{" "}
                    {diagnostic.pipelineNameEmptyCount}
                  </span>
                </div>
                <div className="research-meta-row">
                  <span>edge 候选 / 保留</span>
                  <span>
                    {diagnostic.edgeCandidateCount} /{" "}
                    {diagnostic.edgeValidatedCount}
                  </span>
                </div>
                <div className="research-meta-row">
                  <span>edge 校验回退</span>
                  <span>{diagnostic.edgeValidateFallbackCount}</span>
                </div>
              </>
            )}
            <div className="support-item-text research-path-text">
              {paper.path}
            </div>
            <div className="support-item-actions">
              <button
                className="action-button"
                onClick={() => void handleOpenFile(paper.path)}
              >
                Open paper
              </button>
            </div>
          </div>
        );
      })}
    </>
  );

  const graphBody = (
    <>
      <div className="research-toolbar split">
        <div className="research-inline-tabs">
          <button
            className={`research-inline-tab ${graphView === "method" ? "active" : ""}`}
            onClick={() => setGraphView("method")}
          >
            Method DAG
          </button>
          <button
            className={`research-inline-tab ${graphView === "problem" ? "active" : ""}`}
            onClick={() => setGraphView("problem")}
          >
            Problem DAG
          </button>
          <button
            className={`research-inline-tab ${graphView === "idea" ? "active" : ""}`}
            onClick={() => setGraphView("idea")}
          >
            Idea Map
          </button>
        </div>
        <button
          className="action-button"
          onClick={() => void loadGraph(graphView, true)}
          disabled={isGraphLoading}
          title="重新读取图谱视图，不会重置审核结果"
        >
          {isGraphLoading ? "刷新中..." : "刷新视图"}
        </button>
      </div>

      <div className="research-card">
        <div className="research-card-head">
          <strong>Graph Canvas</strong>
          <span className="research-chip">
            {activeGraph?.nodes.length ?? 0} nodes ·{" "}
            {activeGraph?.edges.length ?? 0} edges
          </span>
        </div>
        <div className="support-item-text">
          在独立弹出画布里查看节点、连线、高亮关系和右侧证据面板。
        </div>
        <div className="support-item-actions">
          <button
            className="action-button primary"
            onClick={() => setIsGraphCanvasOpen(true)}
            disabled={!activeGraph || activeGraph.nodes.length === 0}
          >
            Open Graph Canvas
          </button>
        </div>
      </div>

      {activeGraph ? (
        <>
          {orphanNodes.length > 0 && (
            <>
              <div className="research-section-title">Orphans</div>
              <div className="research-tag-row">
                {orphanNodes.slice(0, 20).map((node) => (
                  <button
                    key={node.id}
                    className="research-tag-button orphan"
                    onClick={() => void handleSelectGraphNode(node.id)}
                  >
                    {graphKindLabels[node.kind]}: {node.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <div className="support-empty">
          {isGraphLoading ? "图谱加载中..." : "还没有已审核图谱数据。"}
        </div>
      )}
    </>
  );

  const reviewBody = (
    <>
      <div className="research-toolbar split">
        <div className="research-section-title tight">Review Queue</div>
        <button
          className="action-button"
          onClick={() => void loadReviews(true)}
          disabled={isReviewLoading}
          title="重新读取审核队列，不会重置审核结果；会尝试补回缺失 edge"
        >
          {isReviewLoading ? "刷新中..." : "刷新视图"}
        </button>
      </div>
      <div className="research-inline-tabs review-filter-tabs">
        {(Object.keys(reviewFilterLabels) as ReviewFilter[]).map((filter) => (
          <button
            key={filter}
            className={`research-inline-tab ${reviewFilter === filter ? "active" : ""}`}
            onClick={() => setReviewFilter(filter)}
          >
            {reviewFilterLabels[filter]} ({reviewCounts[filter]})
          </button>
        ))}
      </div>
      {filteredReviews.length === 0 && !isReviewLoading && (
        <div className="support-empty">没有待审核候选。</div>
      )}
      {filteredReviews.map((review) => {
        const headline =
          review.candidateKind === "node"
            ? `${graphKindLabels[(review.entityKind as GraphNodeKind) || "task"]}: ${review.label || "Untitled"}`
            : `${review.fromLabel || "?"} → ${review.toLabel || "?"}`;
        return (
          <div key={review.reviewId} className="research-card">
            <div className="research-card-head">
              <strong>{headline}</strong>
              <span className="research-chip">
                {scoreLabel(review.confidence)}
              </span>
            </div>
            <div className="research-meta-row">
              <span>{review.paperTitle}</span>
              <span>{review.candidateKind}</span>
            </div>
            {review.description && (
              <div className="support-item-text">
                {trimText(review.description, 220)}
              </div>
            )}
            {review.candidateKind === "node" && (
              <input
                className="research-text-input compact"
                value={
                  overrideLabels[review.candidateId] ??
                  review.suggestedCanonicalLabel ??
                  review.label ??
                  ""
                }
                onChange={(event) =>
                  setOverrideLabels((current) => ({
                    ...current,
                    [review.candidateId]: event.target.value,
                  }))
                }
                placeholder="Canonical label override"
              />
            )}
            <div className="research-evidence-list">
              {review.evidence.slice(0, 2).map((evidence, index) => (
                <div
                  key={`${review.reviewId}:${index}`}
                  className="research-evidence-item"
                >
                  <div className="research-meta-row">
                    <span>
                      {pageLabel(evidence.pageStart, evidence.pageEnd)}
                    </span>
                    <span>{evidence.sourceType}</span>
                  </div>
                  <div className="support-item-text">
                    {trimText(evidence.snippet, 180)}
                  </div>
                </div>
              ))}
            </div>
            <div className="support-item-actions">
              <button
                className="action-button"
                onClick={() =>
                  void handleOpenFile(
                    review.paperPath,
                    review.evidence[0]?.pageStart,
                    review.evidence[0]?.snippet,
                  )
                }
              >
                Open paper
              </button>
              <button
                className="action-button primary"
                onClick={() => void handleDecision(review, "approve")}
                disabled={applyingCandidateId === review.candidateId}
              >
                Approve
              </button>
              <button
                className="action-button danger"
                onClick={() => void handleDecision(review, "reject")}
                disabled={applyingCandidateId === review.candidateId}
              >
                Reject
              </button>
            </div>
          </div>
        );
      })}
    </>
  );

  const ideasBody = (
    <>
      <div className="research-toolbar split">
        <div className="research-section-title tight">Idea Candidates</div>
        <button
          className="action-button"
          onClick={() => void loadIdeas(true)}
          disabled={isIdeasLoading}
          title="重新读取 Idea 候选，不会重置审核结果"
        >
          {isIdeasLoading ? "刷新中..." : "刷新视图"}
        </button>
      </div>
      {ideas.length === 0 && !isIdeasLoading && (
        <div className="support-empty">当前还没有可推荐的图谱断点。</div>
      )}
      {ideas.map((idea) => (
        <div key={idea.id} className="research-card">
          <div className="research-card-head">
            <strong>{idea.title}</strong>
            <span className="research-chip">{idea.ruleType}</span>
          </div>
          <div className="research-meta-row">
            <span>confidence {scoreLabel(idea.confidence)}</span>
            <span>{idea.evidence.length} evidence refs</span>
          </div>
          <div className="support-item-text">{trimText(idea.summary, 240)}</div>
          <div className="research-evidence-list">
            {idea.evidence.slice(0, 2).map((evidence, index) => (
              <div
                key={`${idea.id}:${index}`}
                className="research-evidence-item"
              >
                <div className="research-meta-row">
                  <span>{evidence.paperTitle}</span>
                  <span>{pageLabel(evidence.pageStart, evidence.pageEnd)}</span>
                </div>
                <div className="support-item-text">
                  {trimText(evidence.snippet, 160)}
                </div>
                <div className="support-item-actions">
                  <button
                    className="action-button"
                    onClick={() =>
                      void handleOpenFile(
                        evidence.paperPath,
                        evidence.pageStart,
                        evidence.snippet,
                      )
                    }
                  >
                    Open evidence
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );

  return (
    <div className="sidebar-tool-scroll">
      <div className="research-card">
        <div className="research-card-head">
          <strong>Runtime</strong>
          <span className="research-chip">{ingestStageLabel}</span>
        </div>
        <div className="research-meta-row">
          <span>Chat</span>
          <span>{chatModel}</span>
        </div>
        <div className="research-meta-row">
          <span>Extract Provider</span>
          <span>{extractProviderLabel}</span>
        </div>
        <div className="research-meta-row">
          <span>Extract Fast</span>
          <span>{extractFastModel}</span>
        </div>
        <div className="research-meta-row">
          <span>Extract Fallback</span>
          <span>{extractFallbackModel}</span>
        </div>
        <div className="research-meta-row">
          <span>Pipeline Summary</span>
          <span>{pipelineSummaryModel}</span>
        </div>
        <div className="research-meta-row">
          <span>Pipeline Name</span>
          <span>{pipelineNameModel}</span>
        </div>
        <div className="research-meta-row">
          <span>Edge Extract</span>
          <span>{edgeExtractModel}</span>
        </div>
        <div className="research-meta-row">
          <span>Edge Validate</span>
          <span>{edgeValidateModel}</span>
        </div>
        <div className="research-meta-row">
          <span>Translate</span>
          <span>{translationModel}</span>
        </div>
        {ingestProgress && (
          <div className="support-item-text">
            {ingestProgress.message}
            {ingestProgress.total > 0
              ? ` (${ingestProgress.current}/${ingestProgress.total})`
              : ""}
            {ingestProgress.stage === "candidate_extract" && (
              <>
                {" · "}
                无候选 {ingestProgress.noCandidateCount ?? 0}
                {" · "}
                回退成功 {ingestProgress.fallbackSuccessCount ?? 0}
                {" · "}
                双重失败 {ingestProgress.doubleFailureCount ?? 0}
              </>
            )}
          </div>
        )}
      </div>

      <div className="research-panel-tabs">
        <button
          className={`research-panel-tab ${activeTab === "papers" ? "active" : ""}`}
          onClick={() => setActiveTab("papers")}
        >
          Papers
        </button>
        <button
          className={`research-panel-tab ${activeTab === "search" ? "active" : ""}`}
          onClick={() => setActiveTab("search")}
        >
          Search
        </button>
        <button
          className={`research-panel-tab ${activeTab === "graph" ? "active" : ""}`}
          onClick={() => setActiveTab("graph")}
        >
          Graph
        </button>
        <button
          className={`research-panel-tab ${activeTab === "review" ? "active" : ""}`}
          onClick={() => setActiveTab("review")}
        >
          Review
        </button>
        <button
          className={`research-panel-tab ${activeTab === "ideas" ? "active" : ""}`}
          onClick={() => setActiveTab("ideas")}
        >
          Ideas
        </button>
      </div>

      {activeTab === "papers"
        ? papersBody
        : activeTab === "search"
          ? searchBody
          : activeTab === "graph"
            ? graphBody
            : activeTab === "review"
              ? reviewBody
              : ideasBody}

      {isGraphCanvasOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="research-graph-overlay"
            onClick={() => setIsGraphCanvasOpen(false)}
          >
            <div
              className="research-graph-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="research-graph-modal-header">
                <div className="research-graph-header-copy">
                  <div className="research-section-title tight research-graph-heading">
                    {graphView === "method"
                      ? "Method DAG Canvas"
                      : graphView === "problem"
                        ? "Problem DAG Canvas"
                        : "Idea Map Canvas"}
                  </div>
                  <div className="research-graph-summary-row">
                    <span className="research-graph-summary-pill">
                      {activeGraph?.nodes.length ?? 0} nodes
                    </span>
                    <span className="research-graph-summary-pill">
                      {activeGraph?.edges.length ?? 0} edges
                    </span>
                  </div>
                  <div className="research-graph-subtitle">
                    Dagre layout · space canvas · pan and zoom enabled
                  </div>
                </div>
                <div className="support-item-actions research-graph-controls">
                  <button
                    className="action-button"
                    onClick={() => zoomGraphBy(0.76)}
                    disabled={!activeGraph || activeGraph.nodes.length === 0}
                    aria-label="Zoom out"
                  >
                    -
                  </button>
                  <button
                    className="action-button"
                    onClick={() => zoomGraphBy(1.32)}
                    disabled={!activeGraph || activeGraph.nodes.length === 0}
                    aria-label="Zoom in"
                  >
                    +
                  </button>
                  <button
                    className="action-button"
                    onClick={() => fitGraphView()}
                  >
                    Fit
                  </button>
                  <button
                    className="action-button"
                    onClick={() => {
                      resetGraphView();
                    }}
                  >
                    Reset View
                  </button>
                  <button
                    className="action-button"
                    onClick={() => setIsGraphCanvasOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="research-graph-workspace">
                <div className="research-graph-stage-panel">
                  {activeGraph && activeGraph.nodes.length > 0 ? (
                    <div
                      className={`research-graph-canvas fullscreen dark ${
                        isStarScrollOpen ? "is-print-open" : ""
                      }`}
                    >
                      <canvas
                        ref={starDustCanvasRef}
                        className="star-dust-canvas"
                        aria-hidden="true"
                      />
                      <div className="research-graph-lane-strip">
                        {graphLaneDefinitions[graphView].map((lane) => (
                          <span
                            key={lane.kind}
                            className={`research-graph-lane-chip ${lane.kind}`}
                          >
                            {lane.label}
                          </span>
                        ))}
                      </div>
                      <div
                        className="research-graph-canvas-switcher"
                        aria-label="Graph view switcher"
                      >
                        <button
                          className={`research-graph-canvas-switch ${
                            graphView === "method" ? "active" : ""
                          }`}
                          onClick={() => setGraphView("method")}
                        >
                          Method
                        </button>
                        <button
                          className={`research-graph-canvas-switch ${
                            graphView === "problem" ? "active" : ""
                          }`}
                          onClick={() => setGraphView("problem")}
                        >
                          Problem
                        </button>
                        <button
                          className={`research-graph-canvas-switch ${
                            graphView === "idea" ? "active" : ""
                          }`}
                          onClick={() => setGraphView("idea")}
                        >
                          Idea
                        </button>
                      </div>
                      <div
                        ref={graphCanvasRef}
                        className="research-graph-cytoscape"
                        role="img"
                        aria-label={`${graphView} graph`}
                      />
                      <svg
                        className="star-edge-flow-overlay"
                        aria-hidden="true"
                        onClick={(event) => {
                          if (event.target !== event.currentTarget) return;
                          clearGraphCanvasSelection();
                        }}
                      >
                        <defs>
                          <filter
                            id="star-edge-spark-glow"
                            x="-80%"
                            y="-80%"
                            width="260%"
                            height="260%"
                          >
                            <feGaussianBlur stdDeviation="3.8" result="blur" />
                            <feMerge>
                              <feMergeNode in="blur" />
                              <feMergeNode in="SourceGraphic" />
                            </feMerge>
                          </filter>
                        </defs>
                        {starEdgeFlows.map((edge, index) => {
                          const isSelected = selectedGraphEdgeId === edge.id;
                          const isRevealed =
                            !edge.from ||
                            !edge.to ||
                            (enteredStarIds.has(edge.from) &&
                              enteredStarIds.has(edge.to));
                          const className = [
                            "star-edge-flow",
                            edge.isIdea ? "is-idea" : "",
                            isRevealed ? "is-revealed" : "",
                            isSelected ? "is-selected" : "",
                          ]
                            .filter(Boolean)
                            .join(" ");
                          return (
                            <g key={edge.id} className={className}>
                              <path
                                className="star-edge-hit-path"
                                d={edge.d}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  if (graphView === "idea" || edge.isIdea) {
                                    return;
                                  }
                                  void handleSelectGraphEdge(edge.id);
                                }}
                                onPointerEnter={() => {
                                  const cy = cyRef.current;
                                  if (!cy) return;
                                  cy.getElementById(edge.id).addClass(
                                    "graph-hover-edge",
                                  );
                                }}
                                onPointerLeave={() => {
                                  const cy = cyRef.current;
                                  if (!cy) return;
                                  cy.getElementById(edge.id).removeClass(
                                    "graph-hover-edge",
                                  );
                                }}
                              />
                              <path
                                className="star-edge-flow-line"
                                d={edge.d}
                                data-edge-id={edge.id}
                                id={`star-edge-path-${edge.id}`}
                              />
                              {[0, 1, 2, 3, 4].map((sparkIndex) => (
                                <circle
                                  key={`${edge.id}:${sparkIndex}`}
                                  className="star-edge-spark"
                                  data-edge-id={edge.id}
                                  r={
                                    sparkIndex === 0
                                      ? 2.35
                                      : sparkIndex % 2 === 0
                                        ? 1.75
                                        : 1.25
                                  }
                                  filter="url(#star-edge-spark-glow)"
                                >
                                  <animateMotion
                                    path={edge.d}
                                    dur={`${4.4 + ((index + sparkIndex) % 5) * 0.52}s`}
                                    begin={`${-(index * 0.31 + sparkIndex * 0.78)}s`}
                                    repeatCount="indefinite"
                                  />
                                </circle>
                              ))}
                              {edge.isIdea && edge.label && (
                                <text className="star-edge-label">
                                  <textPath
                                    href={`#star-edge-path-${edge.id}`}
                                    startOffset="46%"
                                  >
                                    {edge.label}
                                  </textPath>
                                </text>
                              )}
                            </g>
                          );
                        })}
                      </svg>
                      <div className="star-map-overlay" aria-hidden="true">
                        {starGlyphs.map((glyph) => {
                          const isSelected = selectedGraphNodeId === glyph.id;
                          const isHovered = hoveredGraphNodeId === glyph.id;
                          const isNeighbor =
                            neighborStarIds.has(glyph.id) && !isSelected;
                          const isDimmed = dimmedStarIds.has(glyph.id);
                          const isSpinning = spinningStarIds.has(glyph.id);
                          const isIdea = glyph.kind === "idea";
                          const className = [
                            "star-glyph",
                            `star-glyph-${glyph.kind}`,
                            enteredStarIds.has(glyph.id) ? "is-entered" : "",
                            isSelected ? "is-selected" : "",
                            isHovered ? "is-hovered" : "",
                            isNeighbor ? "is-neighbor" : "",
                            isDimmed ? "is-dimmed" : "",
                            isSpinning ? "is-spinning is-popping" : "",
                          ]
                            .filter(Boolean)
                            .join(" ");
                          return (
                            <div
                              key={glyph.id}
                              className={className}
                              data-node-id={glyph.id}
                              onPointerDown={(event) =>
                                beginStarGlyphDrag(event, glyph.id)
                              }
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                triggerStarTapAnimation(glyph.id);
                                syncStarFocusFromNode(glyph.id);
                                void handleSelectGraphNode(glyph.id);
                              }}
                              style={{
                                left: `${glyph.x}px`,
                                top: `${glyph.y}px`,
                              }}
                            >
                              {isIdea ? (
                                <>
                                  <span className="star-glyph-image idea-pulsar-image" />
                                  <span className="idea-pulsar-orbit" />
                                  <span className="idea-pulsar-orbit secondary" />
                                </>
                              ) : (
                                <span className="star-glyph-image" />
                              )}
                              <span className="star-glyph-copy">
                                <span className="star-glyph-type">
                                  {graphKindLabels[glyph.kind] ??
                                    glyph.kindLabel}
                                </span>
                                <span className="star-glyph-label">
                                  {glyph.label}
                                </span>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      <div
                        className={`star-scroll-reveal ${
                          isStarScrollOpen ? "is-open" : ""
                        }`}
                        aria-hidden="true"
                      />
                      {moduleTooltip && (
                        <div
                          className="research-graph-tooltip"
                          style={{
                            left: `${moduleTooltip.x}px`,
                            top: `${moduleTooltip.y}px`,
                          }}
                        >
                          <div className="research-graph-tooltip-kind">
                            MODULE
                          </div>
                          <div className="research-graph-tooltip-title">
                            {moduleTooltip.title}
                          </div>
                          {moduleTooltip.description && (
                            <div className="research-graph-tooltip-text">
                              {trimText(moduleTooltip.description, 220)}
                            </div>
                          )}
                          {moduleTooltip.evidence.length > 0 && (
                            <div className="research-graph-tooltip-evidence">
                              {moduleTooltip.evidence.map((evidence, index) => (
                                <div key={`${moduleTooltip.nodeId}:${index}`}>
                                  {trimText(evidence.snippet, 140)}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="support-empty">
                      当前视图还没有可绘制图谱数据。
                    </div>
                  )}
                </div>

                <aside className="research-graph-detail-panel">
                  <div className="research-section-title tight">Details</div>
                  {isGraphDetailLoading && (
                    <div className="support-empty">加载图详情中...</div>
                  )}
                  {!isGraphDetailLoading &&
                    !selectedGraphNodeDetail &&
                    !selectedGraphEdgeDetail &&
                    !selectedIdea && (
                      <div className="support-empty">
                        点击一个节点或边，在右侧查看证据和关联论文。
                      </div>
                    )}
                  {selectedIdea && (
                    <div className="research-card idea-detail-card">
                      <div className="research-card-head">
                        <strong>Idea: {selectedIdea.title}</strong>
                        <span className="research-chip">
                          {selectedIdea.ruleType}
                        </span>
                      </div>
                      <div className="research-meta-row">
                        <span>
                          confidence {scoreLabel(selectedIdea.confidence)}
                        </span>
                        <span>
                          {selectedIdea.evidence.length} evidence refs
                        </span>
                      </div>
                      {!isIdeaEditing && (
                        <div className="support-item-text">
                          {trimText(selectedIdea.summary, 280)}
                        </div>
                      )}
                      {selectedIdeaLinkedNodes.length > 0 && (
                        <>
                          <div className="research-section-title">Linked</div>
                          <div className="research-tag-row">
                            {selectedIdeaLinkedNodes.map((node) => (
                              <button
                                key={`idea-link:${node.id}`}
                                className="research-tag-button"
                                onClick={() =>
                                  void handleSelectGraphNode(node.id)
                                }
                              >
                                {graphKindLabels[node.kind]}: {node.label}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                      {isIdeaEditing && (
                        <>
                          <input
                            className="research-text-input compact"
                            value={ideaDraft.title}
                            onChange={(event) =>
                              setIdeaDraft((current) => ({
                                ...current,
                                title: event.target.value,
                              }))
                            }
                            placeholder="Idea title"
                          />
                          <textarea
                            className="research-text-input"
                            rows={6}
                            value={ideaDraft.summary}
                            onChange={(event) =>
                              setIdeaDraft((current) => ({
                                ...current,
                                summary: event.target.value,
                              }))
                            }
                            placeholder="Idea summary"
                          />
                        </>
                      )}
                      {ideaSaveError && (
                        <div className="support-item-text">{ideaSaveError}</div>
                      )}
                      <div className="support-item-actions">
                        {!isIdeaEditing ? (
                          <button
                            className="action-button"
                            onClick={beginIdeaEdit}
                          >
                            Edit
                          </button>
                        ) : (
                          <>
                            <button
                              className="action-button primary"
                              onClick={() => void saveIdeaEdit()}
                              disabled={isIdeaSaving}
                            >
                              {isIdeaSaving ? "Saving..." : "Save"}
                            </button>
                            <button
                              className="action-button"
                              onClick={cancelIdeaEdit}
                              disabled={isIdeaSaving}
                            >
                              Cancel
                            </button>
                          </>
                        )}
                      </div>
                      {selectedIdea.evidence.length > 0 && (
                        <>
                          <div className="research-section-title">Evidence</div>
                          <div className="research-evidence-list">
                            {selectedIdea.evidence
                              .slice(0, 6)
                              .map((evidence, index) => (
                                <div
                                  key={`${selectedIdea.id}:${index}`}
                                  className="research-evidence-item"
                                >
                                  <div className="research-meta-row">
                                    <span>{evidence.paperTitle}</span>
                                    <span>
                                      {pageLabel(
                                        evidence.pageStart,
                                        evidence.pageEnd,
                                      )}
                                    </span>
                                  </div>
                                  <div className="support-item-text">
                                    {trimText(evidence.snippet, 180)}
                                  </div>
                                  <div className="support-item-actions">
                                    <button
                                      className="action-button"
                                      onClick={() =>
                                        void handleOpenFile(
                                          evidence.paperPath,
                                          evidence.pageStart,
                                          evidence.snippet,
                                        )
                                      }
                                    >
                                      Open evidence
                                    </button>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {selectedGraphNodeDetail && (
                    <div className="research-card">
                      <div className="research-card-head">
                        <strong>
                          {graphKindLabels[
                            (selectedGraphNodeDetail.kind as GraphNodeKind) ||
                              "task"
                          ] || selectedGraphNodeDetail.kind}
                          : {selectedGraphNodeDetail.label}
                        </strong>
                        <span className="research-chip">
                          {selectedGraphNodeDetail.supportCount}
                        </span>
                      </div>
                      {selectedGraphNodeDetail.description && (
                        <div className="support-item-text">
                          {trimText(selectedGraphNodeDetail.description, 220)}
                        </div>
                      )}
                      {selectedGraphNodeDetail.aliases.length > 1 && (
                        <div className="research-tag-row">
                          {selectedGraphNodeDetail.aliases
                            .slice(0, 8)
                            .map((alias) => (
                              <span key={alias} className="research-tag">
                                {alias}
                              </span>
                            ))}
                        </div>
                      )}
                      {selectedGraphNodeDetail.adjacentNodes.length > 0 && (
                        <>
                          <div className="research-section-title">Adjacent</div>
                          <div className="research-tag-row">
                            {selectedGraphNodeDetail.adjacentNodes
                              .slice(0, 12)
                              .map((node) => (
                                <button
                                  key={`${node.direction}:${node.nodeId}:${node.edgeType}`}
                                  className="research-tag-button"
                                  onClick={() =>
                                    void handleSelectGraphNode(node.nodeId)
                                  }
                                >
                                  {node.direction === "incoming" ? "←" : "→"}{" "}
                                  {node.label}
                                </button>
                              ))}
                          </div>
                        </>
                      )}
                      {selectedGraphNodeDetail.relatedPapers.length > 0 && (
                        <>
                          <div className="research-section-title">Papers</div>
                          <div className="research-evidence-list">
                            {selectedGraphNodeDetail.relatedPapers
                              .slice(0, 6)
                              .map((paper) => (
                                <div
                                  key={paper.paperId}
                                  className="research-evidence-item"
                                >
                                  <div className="support-item-text">
                                    {paper.title}
                                  </div>
                                  <div className="support-item-actions">
                                    <button
                                      className="action-button"
                                      onClick={() =>
                                        void handleOpenFile(paper.path)
                                      }
                                    >
                                      Open paper
                                    </button>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </>
                      )}
                      {selectedGraphNodeDetail.evidence.length > 0 && (
                        <>
                          <div className="research-section-title">Evidence</div>
                          <div className="research-evidence-list">
                            {selectedGraphNodeDetail.evidence
                              .slice(0, 6)
                              .map((evidence, index) => (
                                <div
                                  key={`${selectedGraphNodeDetail.nodeId}:${index}`}
                                  className="research-evidence-item"
                                >
                                  <div className="research-meta-row">
                                    <span>{evidence.paperTitle}</span>
                                    <span>
                                      {pageLabel(
                                        evidence.pageStart,
                                        evidence.pageEnd,
                                      )}
                                    </span>
                                  </div>
                                  <div className="support-item-text">
                                    {trimText(evidence.snippet, 180)}
                                  </div>
                                  <div className="support-item-actions">
                                    <button
                                      className="action-button"
                                      onClick={() =>
                                        void handleOpenFile(
                                          evidence.paperPath,
                                          evidence.pageStart,
                                          evidence.snippet,
                                        )
                                      }
                                    >
                                      Open evidence
                                    </button>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {selectedGraphEdgeDetail && (
                    <div className="research-card">
                      <div className="research-card-head">
                        <strong>
                          {selectedGraphEdgeDetail.fromLabel} →{" "}
                          {selectedGraphEdgeDetail.toLabel}
                        </strong>
                        <span className="research-chip">
                          {selectedGraphEdgeDetail.supportCount}
                        </span>
                      </div>
                      <div className="research-meta-row">
                        <span>edge</span>
                        <span>{selectedGraphEdgeDetail.edgeType}</span>
                      </div>
                      {selectedGraphEdgeDetail.relatedPapers.length > 0 && (
                        <>
                          <div className="research-section-title">Papers</div>
                          <div className="research-evidence-list">
                            {selectedGraphEdgeDetail.relatedPapers
                              .slice(0, 6)
                              .map((paper) => (
                                <div
                                  key={paper.paperId}
                                  className="research-evidence-item"
                                >
                                  <div className="support-item-text">
                                    {paper.title}
                                  </div>
                                  <div className="support-item-actions">
                                    <button
                                      className="action-button"
                                      onClick={() =>
                                        void handleOpenFile(paper.path)
                                      }
                                    >
                                      Open paper
                                    </button>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </>
                      )}
                      {selectedGraphEdgeDetail.evidence.length > 0 && (
                        <>
                          <div className="research-section-title">Evidence</div>
                          <div className="research-evidence-list">
                            {selectedGraphEdgeDetail.evidence
                              .slice(0, 6)
                              .map((evidence, index) => (
                                <div
                                  key={`${selectedGraphEdgeDetail.edgeId}:${index}`}
                                  className="research-evidence-item"
                                >
                                  <div className="research-meta-row">
                                    <span>{evidence.paperTitle}</span>
                                    <span>
                                      {pageLabel(
                                        evidence.pageStart,
                                        evidence.pageEnd,
                                      )}
                                    </span>
                                  </div>
                                  <div className="support-item-text">
                                    {trimText(evidence.snippet, 180)}
                                  </div>
                                  <div className="support-item-actions">
                                    <button
                                      className="action-button"
                                      onClick={() =>
                                        void handleOpenFile(
                                          evidence.paperPath,
                                          evidence.pageStart,
                                          evidence.snippet,
                                        )
                                      }
                                    >
                                      Open evidence
                                    </button>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </aside>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

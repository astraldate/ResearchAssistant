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
type GraphView = "method" | "problem";
type GraphNodeKind = "task" | "pipeline" | "module" | "challenge" | "insight";
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
};

const graphKindLabels: Record<GraphNodeKind, string> = {
  task: "Task",
  pipeline: "Pipeline",
  module: "Module",
  challenge: "Challenge",
  insight: "Insight",
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
};

const graphKindCodes: Record<GraphNodeKind, string> = {
  task: "TASK",
  pipeline: "PIPE",
  module: "MOD",
  challenge: "CHAL",
  insight: "INS",
};

const trimText = (value: string, limit: number) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
};

const formatGraphNodeLabel = (node: ResearchGraphNode) =>
  `${graphKindCodes[node.kind]}\n${node.label}`;

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
      grabbable: false,
      locked: true,
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
  const graphCanvasRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<CytoscapeCore | null>(null);

  const activeGraph = graphCache[graphView] ?? null;
  const orphanNodes = useMemo(
    () => (activeGraph?.nodes ?? []).filter((node) => node.isOrphan),
    [activeGraph],
  );
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
    if (!isGraphCanvasOpen || !graphCanvasRef.current || !activeGraph) return;

    const usePresetLayout = activeGraph.edges.length === 0;

    const cy = cytoscape({
      container: graphCanvasRef.current,
      elements: buildGraphElements(activeGraph, graphView),
      autoungrabify: true,
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
            height: "74px",
            padding: "14px",
            label: "data(label)",
            "text-wrap": "wrap",
            "text-max-width": 176,
            color: "#f8fbff",
            "font-size": 16,
            "font-weight": 800,
            "text-valign": "center",
            "text-halign": "center",
            "background-color": "data(color)",
            "border-width": 2,
            "border-color": "#dbe9ff",
            "overlay-opacity": 0,
            "underlay-opacity": 0.16,
            "underlay-padding": 8,
            "underlay-color": "data(color)",
            "text-outline-width": 0,
          },
        },
        {
          selector: "node.graph-node-orphan",
          style: {
            "border-style": "dashed",
            "border-color": "#ffe1bf",
          },
        },
        {
          selector: "edge.graph-edge",
          style: {
            width: 3,
            "curve-style": "bezier",
            "line-color": "#47b3ff",
            "target-arrow-color": "#ffb048",
            "target-arrow-shape": "triangle-backcurve",
            "arrow-scale": 1.35,
            opacity: 0.85,
          },
        },
        {
          selector: ".graph-dimmed",
          style: {
            opacity: 0.12,
          },
        },
        {
          selector: "node.graph-selected",
          style: {
            "border-width": 3,
            "border-color": "#ffffff",
            "underlay-opacity": 0.34,
            "underlay-padding": 18,
          },
        },
        {
          selector: "edge.graph-selected",
          style: {
            width: 5,
            opacity: 1,
            "line-color": "#79d2ff",
            "target-arrow-color": "#ffd071",
          },
        },
        {
          selector: "node.graph-neighbor",
          style: {
            opacity: 1,
            "underlay-opacity": 0.28,
            "underlay-padding": 14,
          },
        },
        {
          selector: "node.graph-hovered",
          style: {
            "border-width": 3,
            "border-color": "#ffffff",
            "underlay-opacity": 0.44,
            "underlay-padding": 20,
          },
        },
        {
          selector: "edge.graph-hover-edge",
          style: {
            width: 6,
            opacity: 1,
            "line-color": "#7bd8ff",
            "target-arrow-color": "#ffbf67",
            "line-style": "dashed",
          },
        },
      ] as any,
      layout: {
        name: usePresetLayout ? "preset" : "dagre",
        rankDir: "LR",
        nodeSep: 44,
        edgeSep: 22,
        rankSep: graphView === "method" ? 180 : 220,
        animate: false,
        fit: true,
        padding: 60,
        ranker: "tight-tree",
      } as any,
    });

    cyRef.current = cy;

    const clearHoverClasses = () => {
      cy.elements().removeClass(
        "graph-hovered graph-hover-edge graph-neighbor graph-dimmed",
      );
    };

    cy.on("tap", "node.graph-node", (event) => {
      const node = event.target;
      void handleSelectGraphNode(node.id());
    });

    cy.on("tap", "edge.graph-edge", (event) => {
      const edge = event.target;
      void handleSelectGraphEdge(edge.id());
    });

    cy.on("tap", (event) => {
      if (event.target !== cy) return;
      setSelectedGraphNodeId(null);
      setSelectedGraphEdgeId(null);
      setSelectedGraphNodeDetail(null);
      setSelectedGraphEdgeDetail(null);
      setModuleTooltip(null);
      clearHoverClasses();
      cy.elements().removeClass("graph-selected graph-neighbor graph-dimmed");
    });

    cy.on("mouseover", "node.graph-node", (event) => {
      const node = event.target;
      setHoveredGraphNodeId(node.id());
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
      clearHoverClasses();
      applyGraphSelectionState();
    });

    cy.on("zoom pan render resize", syncModuleTooltipPosition);
    cy.ready(() => {
      window.requestAnimationFrame(() => {
        if (!usePresetLayout && shouldFallbackToPresetLayout(cy)) {
          cy.layout({
            name: "preset",
            fit: true,
            padding: 80,
            animate: false,
          } as any).run();
        }
        resetGraphView();
        applyGraphSelectionState();
        syncModuleTooltipPosition();
      });
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [activeGraph, graphView, isGraphCanvasOpen]);

  useEffect(() => {
    applyGraphSelectionState();
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

  async function handleSelectGraphNode(nodeId: string) {
    setSelectedGraphNodeId(nodeId);
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
    setSelectedGraphEdgeId(edgeId);
    setSelectedGraphNodeId(null);
    setSelectedGraphNodeDetail(null);
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
                      : "Problem DAG Canvas"}
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
                    <div className="research-graph-canvas fullscreen dark">
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
                        ref={graphCanvasRef}
                        className="research-graph-cytoscape"
                        role="img"
                        aria-label={`${graphView} graph`}
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
                    !selectedGraphEdgeDetail && (
                      <div className="support-empty">
                        点击一个节点或边，在右侧查看证据和关联论文。
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

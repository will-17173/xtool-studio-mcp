/**
 * SVG import/export for the neutral Design model.
 *
 * Export is full-fidelity for our own shapes. Import is best-effort for common
 * SVG primitives (rect, circle, ellipse, line, polyline, polygon, path) and
 * preserves `<path d>` verbatim.
 */
import {
  type Design,
  type Shape,
  type OpParams,
  shapeToPathD
} from "./design.js";

const OP_STROKE: Record<OpParams["type"], string> = {
  cut: "#000000",
  score: "#0000ff",
  engrave: "#ff0000"
};

/** Serialize a Design to an SVG string (mm units), embedding op params as data-*. */
export function designToSvg(design: Design): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${design.widthMm}mm" ` +
      `height="${design.heightMm}mm" viewBox="0 0 ${design.widthMm} ${design.heightMm}">`
  );
  if (design.meta?.title) parts.push(`<title>${escapeXml(design.meta.title)}</title>`);

  for (const shape of design.shapes) {
    if (shape.kind === "text") {
      parts.push(
        `<text x="${shape.x}" y="${shape.y}" font-size="${shape.fontSize}" ` +
          `fill="${OP_STROKE.engrave}" ${opAttrs(shape.op)}>${escapeXml(shape.text)}</text>`
      );
      continue;
    }
    const d = shapeToPathD(shape);
    if (!d) continue;
    const isFill = shape.op.type === "engrave";
    const stroke = OP_STROKE[shape.op.type];
    const style = isFill
      ? `fill="${stroke}" stroke="none"`
      : `fill="none" stroke="${stroke}" stroke-width="0.1"`;
    parts.push(`<path d="${d}" ${style} ${opAttrs(shape.op)} data-shape-id="${shape.id}"/>`);
  }

  parts.push("</svg>");
  return parts.join("\n");
}

function opAttrs(op: OpParams): string {
  return (
    `data-op="${op.type}" data-power="${op.power_pct}" data-speed="${op.speed_mm_s}" ` +
    `data-passes="${op.passes}"${op.dpi != null ? ` data-dpi="${op.dpi}"` : ""}`
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface SvgImportOptions {
  /** Default operation applied to imported shapes. */
  defaultOp?: OpParams;
}

const DEFAULT_OP: OpParams = { type: "cut", power_pct: 100, speed_mm_s: 10, passes: 1 };

/** Best-effort parse of an SVG string into a Design. */
export function svgToDesign(svg: string, options: SvgImportOptions = {}): Design {
  const op = options.defaultOp ?? DEFAULT_OP;
  if (svg.length > 500_000) {
    throw new Error("SVG is too large (500KB limit).");
  }
  // Remove inert metadata before recognizing geometry. In particular, an
  // unreferenced definition does not correspond to a visible cutting contour.
  const source = svg.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:title|desc|metadata)\b[^>]*>[\s\S]*?<\/(?:title|desc|metadata)\s*>/gi, "");
  if (/<(?:defs|symbol|use|clipPath|mask|pattern|style|switch)\b/i.test(source)
    || /\b(?:transform|clip-path|mask|display|visibility|opacity)\s*[:=]/i.test(source)
    || (source.match(/<svg\b/gi)?.length ?? 0) !== 1) {
    throw new Error("Flatten SVG transforms, definitions, clipping and visibility before conversion.");
  }
  const allowedElements = new Set(["svg", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path"]);
  for (const [, element] of source.matchAll(/<\/?([A-Za-z_][\w:.-]*)\b/g)) {
    if (!allowedElements.has(element!)) throw new Error(`Unsupported SVG element: ${element}. Flatten it to an explicit path before conversion.`);
  }
  const attrsOf = (tag: string): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z_:-][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[m[1]!] = m[2] ?? m[3]!;
    }
    return attrs;
  };
  const { widthMm, heightMm } = readCanvasSize(attrsOf(source.match(/<svg\b[^>]*>/)?.[0] ?? ""));
  const shapes: Shape[] = [];
  let counter = 0;
  const nextId = (): string => `svg-${++counter}`;

  const num = (v: string | undefined, d = 0): number => {
    if (v === undefined) return d;
    const match = v.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:mm)?$/i);
    const value = Number(match?.[1]);
    if (!Number.isFinite(value)) throw new Error(`Unsupported SVG geometry value: ${v}`);
    return value;
  };

  for (const m of source.matchAll(/<(rect|circle|ellipse|line|polyline|polygon|path)\b([^>]*)\/?>/g)) {
    const kind = m[1]!;
    const a = attrsOf(m[2]!);
    switch (kind) {
      case "rect":
        shapes.push({
          kind: "rect",
          id: nextId(),
          op,
          x: num(a.x),
          y: num(a.y),
          width: num(a.width),
          height: num(a.height),
          ...(a.rx ? { rx: num(a.rx) } : {})
        });
        break;
      case "circle":
        shapes.push({
          kind: "ellipse",
          id: nextId(),
          op,
          cx: num(a.cx),
          cy: num(a.cy),
          rx: num(a.r),
          ry: num(a.r)
        });
        break;
      case "ellipse":
        shapes.push({
          kind: "ellipse",
          id: nextId(),
          op,
          cx: num(a.cx),
          cy: num(a.cy),
          rx: num(a.rx),
          ry: num(a.ry)
        });
        break;
      case "line":
        shapes.push({
          kind: "line",
          id: nextId(),
          op,
          x1: num(a.x1),
          y1: num(a.y1),
          x2: num(a.x2),
          y2: num(a.y2)
        });
        break;
      case "polyline":
      case "polygon":
        shapes.push({
          kind,
          id: nextId(),
          op,
          points: parsePoints(a.points ?? "")
        });
        break;
      case "path":
        if (a.d) shapes.push({ kind: "path", id: nextId(), op, d: a.d });
        break;
    }
  }

  if (shapes.length > 5000) {
    throw new Error("SVG has too many shapes (5000 limit).");
  }
  return { widthMm, heightMm, units: "mm", shapes, meta: { generator: "svgToDesign" } };
}

function parsePoints(s: string): Array<[number, number]> {
  const nums = (s.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!]);
  return pts;
}

function readCanvasSize(attributes: Record<string, string>): { widthMm: number; heightMm: number } {
  const physical = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const mm = Number(value.trim().match(/^([\d.]+)\s*mm$/i)?.[1]);
    if (!(mm > 0) || !Number.isFinite(mm)) {
      throw new Error("Set SVG viewport width and height in millimeters before conversion.");
    }
    return mm;
  };
  const width = physical(attributes.width);
  const height = physical(attributes.height);
  if ((width === undefined) !== (height === undefined)) {
    throw new Error("Supply both SVG viewport dimensions in millimeters.");
  }
  if (attributes.viewBox !== undefined) {
    const viewBox = attributes.viewBox.trim().split(/[\s,]+/).map(Number);
    const [x, y, w, h] = viewBox;
    if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || x !== 0 || y !== 0
      || w === undefined || h === undefined || w <= 0 || h <= 0
      || (width !== undefined && (w !== width || h !== height))) {
      throw new Error("Normalize the SVG to a zero-origin viewBox with one drawing unit per millimeter before conversion.");
    }
    return { widthMm: w, heightMm: h };
  }
  if (width !== undefined && height !== undefined) return { widthMm: width, heightMm: height };
  return { widthMm: 200, heightMm: 200 };
}

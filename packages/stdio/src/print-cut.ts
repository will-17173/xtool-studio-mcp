import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { strToU8, zipSync } from "fflate";
import { loadDxf } from "./dxf.js";

export const printCutMode = "FREE_COMBINATION";
// The right-hand rectangle clears the M2 inkjet module keep-out at the upper left.
export const printAreaMm = { x: 110, y: 23, width: 300, height: 284 };
const printLayer = "#00befe";
const cutLayer = "#fe0002";

export interface PrintCutBoard {
  name: string;
  pngPath: string;
  dxfPath: string;
  widthMm: number;
  heightMm: number;
  dxfTopLeftXMm: number;
  dxfTopLeftYMm: number;
}

export interface PrintCutMaterialPreset {
  id: string | number;
  precautionCodes?: string[];
}

export async function createM2PrintCutProject(
  projectPath: string, boards: PrintCutBoard[],
  powerPct: number, speedMmS: number, passes: number,
  materialPreset?: PrintCutMaterialPreset, measuredMaterialHeightMm?: number
) {
  const archive: Record<string, Uint8Array> = { ".format": strToU8("v2") };
  const add = (path: string, value: unknown) => { archive[path] = strToU8(JSON.stringify(value)); };
  const projectId = randomUUID();
  const deviceId = "JS002-1";
  const printProfile = "profile:ink-print";
  const cutProfile = "profile:laser-cut";
  const processing: Record<string, unknown> = {};
  const vectors: Record<string, string> = {};
  const vectorIndex: Record<string, { hash: string; size: number }> = {};
  const canvasIds: string[] = [];
  const summary = [];

  add("meta/persistence-meta.json", { schemaVersion: "2.0.0", protocol: "xcs-workspace-v2" });
  for (const board of boards) {
    const png = await readFile(board.pngPath);
    if (png.length < 33 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        png.toString("ascii", 12, 16) !== "IHDR") {
      throw new Error(`${board.name}: expected a PNG image.`);
    }
    const pixelWidth = png.readUInt32BE(16);
    const pixelHeight = png.readUInt32BE(20);
    if (!pixelWidth || !pixelHeight ||
        Math.abs(pixelWidth - pixelHeight * board.widthMm / board.heightMm) > 1.5) {
      throw new Error(`${board.name}: PNG aspect ratio does not match the board dimensions.`);
    }
    const { design } = await loadDxf(board.dxfPath, "auto", 0.01,
      { type: "cut", power_pct: powerPct, speed_mm_s: speedMmS, passes },
      { x: board.dxfTopLeftXMm, y: board.dxfTopLeftYMm });
    const canvasId = randomUUID();
    canvasIds.push(canvasId);
    const imageHash = createHash("sha256").update(png).digest("hex");
    const resourcePath = `resources/${imageHash}.png`;
    archive[resourcePath] = png;
    add(`${resourcePath}.meta.json`, { ref: resourcePath, metadata: {
      kind: "image", source: { type: "workspace", value: basename(resourcePath) }
    } });

    const left = printAreaMm.x + (printAreaMm.width - board.widthMm) / 2;
    const top = printAreaMm.y + (printAreaMm.height - board.heightMm) / 2;
    const origin = { x: 0, y: 0 };
    const paint = { paintType: "color", visible: false, color: 0, alpha: 1 };
    const stroke = { ...paint, width: 1, cap: "butt", join: "miter", miterLimit: 4, alignment: 0.5 };
    const common = {
      angle: 0, scale: { x: 1, y: 1 }, skew: origin, pivot: origin, localSkew: origin,
      offsetX: 0, offsetY: 0, lockRatio: true, groupTags: [], visible: true,
      enableTransform: true, visibleState: true, lockState: false, isClosePath: false,
      resourceOrigin: "", customData: { tabBreaks: {}, startPoint: {} }, rootComponentId: "",
      minCanvasVersion: "0.0.0", alpha: 1, fill: paint, stroke, effects: [], transform: [1, 0, 0, 1, 0, 0]
    };
    const layer = (color: string) => ({ layerTag: color, layerColor: color, originColor: color });
    const sx = board.widthMm / pixelWidth;
    const sy = board.heightMm / pixelHeight;
    const image = {
      ...common, ...layer(printLayer), x: left, y: top, id: randomUUID(), name: `${board.name}_Print`,
      type: "BITMAP", zOrder: 1, width: board.widthMm, height: board.heightMm, isFill: true,
      originWidth: pixelWidth, originHeight: pixelHeight, resourcePath, format: "png",
      scale: { x: sx, y: sy }, transform: [sx, 0, 0, sy, 0, 0],
      dpi: { dpiX: 25.4 / sx, dpiY: 25.4 / sy }, opacity: 1, currentUrl: "",
      filterList: [], filterList_V2: [], grayValue: [0, 255], sharpness: 50, brightness: 0,
      contrast: 0, saturation: 0, temperature: 0, tone: 0, modifyData: {}, isGray: false
    };

    const cutGroup = `g-${randomUUID()}`;
    const cuts = design.shapes.map((shape, index) => {
      if (shape.kind !== "polygon" && shape.kind !== "polyline") throw new Error("Expected DXF contour.");
      const xs = shape.points.map(([x]) => x);
      const ys = shape.points.map(([, y]) => y);
      const x = xs.reduce((min, point) => Math.min(min, point), Infinity);
      const y = ys.reduce((min, point) => Math.min(min, point), Infinity);
      const right = xs.reduce((max, point) => Math.max(max, point), -Infinity);
      const bottom = ys.reduce((max, point) => Math.max(max, point), -Infinity);
      if (x < -0.001 || y < -0.001 || right > board.widthMm + 0.001 || bottom > board.heightMm + 0.001) {
        throw new Error(`${board.name}: DXF contour falls outside the artwork. Check the board dimensions and DXF top-left coordinates.`);
      }
      const closed = shape.kind === "polygon";
      const path = shape.points.map(([px, py], i) => `${i ? "L" : "M"} ${px + left} ${py + top}`).join(" ") + (closed ? " Z" : "");
      const hash = createHash("sha256").update(path).digest("hex");
      vectors[hash] = path;
      vectorIndex[hash] = { hash, size: Buffer.byteLength(path) };
      return {
        ...common, ...layer(cutLayer), groupTags: [cutGroup], id: randomUUID(), name: `${board.name}_Cut_${index + 1}`,
        type: "PATH", x: x + left, y: y + top, width: right - x, height: bottom - y, zOrder: index + 2,
        isFill: false, isClosePath: closed, points: [], fillRule: "nonzero", graphicX: 0, graphicY: 0,
        isCompoundPath: false, lineColor: 0xfe0002, fillColor: cutLayer,
        stroke: { ...stroke, color: 0xfe0002, visible: true },
        vectorRef: { vectorHash: hash, bucketType: "svg", originalField: "dPath" }
      };
    });

    const displays = [image, ...cuts];
    add(`canvases/${canvasId}.json`, {
      id: canvasId, title: board.name, hidden: false, type: "2d",
      layerData: {
        [printLayer]: { name: "Print", order: 1, visible: true },
        [cutLayer]: { name: "Cut", order: 2, visible: true }
      },
      groupData: {
        [cutGroup]: { groupName: `${board.name}_Cut`, groupTag: cutGroup, visible: true,
          enableTransform: true, zOrder: displays.length + 1, rotation: 0 }
      },
      batchData: { entryType: "BATCH_TEMPLATE", bindings: [] },
      extendInfo: { version: "2.16.5", minCanvasVersion: "0.0.0", displayProcessConfigMap: {},
        rulerPluginData: { rulerGuide: [] } },
      chunkLayout: { displayCount: displays.length, chunkCount: 1, chunkIndexes: [0] }
    });
    add(`canvases/${canvasId}/displays-0.json`, { canvasId, chunkIndex: 0, displays });
    const bind = (baseProfileId: string, displayIds: string[]) => ({
      bindingId: `binding:${randomUUID()}`, canvasId, mode: printCutMode, baseProfileId, displayIds, patchIds: []
    });
    processing[canvasId] = { id: canvasId, activeMode: printCutMode, modes: {
      [printCutMode]: {
        ignoredDisplayIds: [], data: {
          material: materialPreset?.id ?? 0, thickness: measuredMaterialHeightMm ?? null,
          ...(materialPreset?.precautionCodes && { precautionCodes: materialPreset.precautionCodes }),
          isProcessByLayer: false, pathPlanning: "auto", fillPlanning: "separate", enableRemoveCommonEdge: false },
        profileRefs: [printProfile, cutProfile], patches: {},
        bindings: [bind(printProfile, [image.id]), bind(cutProfile, cuts.map(cut => cut.id))]
      }
    } };
    summary.push({ canvasId, name: board.name, cutCount: cuts.length, cutGroup, xMm: left, yMm: top });
  }

  add("profiles.json", { profiles: {
    [printProfile]: { id: printProfile, processingType: "INK_PRINT", values: {
      repeat: 1, bitmapMode: "grayscale", notResize: true, power: 1, colorDensity: 100,
      brightness: 100, dpi: 1200, processHead: "PRINTER"
    } },
    [cutProfile]: { id: cutProfile, processingType: "VECTOR_CUTTING", values: {
      power: powerPct, speed: speedMmS, repeat: passes, laser: "laser_blue_10W", processHead: "LASER",
      cuttingDrop: false, enableBreakPoint: false, enableKerf: false, enableOverCut: false
    } }
  } });
  add(`devices/device-${deviceId}.json`, {
    id: deviceId, deviceCode: "JS002", extId: "JS002", extName: "M2", power: [10], processing
  });
  add("vectors/svg/index.json", {
    bucketType: "svg", version: "1.0", entryCount: Object.keys(vectors).length, entries: vectorIndex
  });
  add("vectors/svg/data-0.json", { bucketType: "svg", chunkIndex: 0, entries: vectors });
  const now = Date.now();
  add("project.json", {
    __v2__: true, version: "2.0.0", schemaMeta: { schemaVersion: "2.1.0", format: "directory" },
    projectId, projectTraceID: projectId, projectName: basename(projectPath, ".xs"),
    activeCanvasId: canvasIds[0], activeDeviceId: deviceId, created: now, modify: now,
    versionInfo: { source: "pc", appVersion: "1.9.11", savedAt: now, minRequiredVersion: "2.6.0" },
    modules: { canvases: canvasIds, devices: [deviceId] }, customProjectData: { projectTraceID: projectId }
  });
  await writeFile(projectPath, zipSync(archive, { level: 3 }), { flag: "wx" });
  return { projectPath, machine: "M2", laserPowerW: 10, mode: printCutMode, modeName: "Print then Cut",
    materialPresetId: materialPreset?.id ?? null, materialHeightMm: measuredMaterialHeightMm ?? null,
    canvases: summary };
}

import { readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildXcs, getMachine, svgToDesign, validateXcs } from "@xtool-mcp/core";
import { z } from "zod";
import { dxfUnits, loadDxf } from "./dxf.js";
import { createM2PrintCutProject, printAreaMm } from "./print-cut.js";
import { inspectXs, moveXsShapesToLayer, renameXsLayer, renameXsShape, updateXsSettings } from "./xs.js";

const localPath = (...extensions: string[]) =>
  z.string().refine(path => isAbsolute(path) && extensions.includes(extname(path).toLowerCase()), {
    message: `Provide an absolute path ending in ${extensions.join(" or ")}.`
  });

function result(data: Record<string, unknown>) {
  return { structuredContent: data, content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function failure(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
}

const record = z.object({}).passthrough();
const documentSchema = record.extend({
  canvas: z.array(record.extend({ id: z.string(), displays: z.array(record) }))
});
const mapSchema = z.object({ dataType: z.literal("Map"), value: z.array(z.tuple([z.string(), record])) });
const settingsSchema = record.extend({
  processingType: z.string(),
  processIgnore: z.boolean().optional(),
  data: z.record(z.object({
    materialType: z.string(),
    parameter: z.record(record)
  }).passthrough())
});

async function readProject(path: string) {
  const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  return documentSchema.parse(JSON.parse(text));
}

function processingEntries(device: unknown, canvasId: string) {
  const deviceMap = mapSchema.safeParse(record.safeParse(device).data?.data);
  const canvas = deviceMap.data?.value.find(([id]) => id === canvasId)?.[1];
  return mapSchema.safeParse(canvas?.displays).data?.value ?? [];
}

function activeSettings(raw: unknown) {
  const entry = settingsSchema.safeParse(raw).data;
  const operation = entry && entry.data[entry.processingType];
  const parameters = operation?.parameter[operation.materialType];
  return entry && operation && parameters ? { entry, operation, parameters } : undefined;
}

const xcsLaserOperations = new Set([
  "VECTOR_CUTTING", "VECTOR_ENGRAVING", "COLOR_FILL_ENGRAVE", "FILL_VECTOR_ENGRAVING",
  "COLOR_ENGRAVE", "BITMAP_ENGRAVE", "INTAGLIO"
]);

export function registerProjectTools(server: McpServer): void {
  server.registerTool("studio_create_m2_print_cut_project", {
    description: "Create a local XS v2 project for the M2 10W blue laser in Studio's Print then Cut mode (FREE_COMBINATION). Each board has a full-board PNG for the CMYK inkjet module and one aligned group of DXF contours for laser cutting. Centers each board within the right-hand 300 x 284 mm inkjet area, clear of the upper-left keep-out. The DXF top-left coordinates are in millimeters with Y up. Saves the project without starting processing.",
    inputSchema: {
      projectPath: localPath(".xs"),
      boards: z.array(z.object({
        name: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        pngPath: localPath(".png"),
        dxfPath: localPath(".dxf"),
        widthMm: z.number().positive().max(printAreaMm.width),
        heightMm: z.number().positive().max(printAreaMm.height),
        dxfTopLeftXMm: z.number().finite(),
        dxfTopLeftYMm: z.number().finite()
      })).min(1).max(30).refine(boards => new Set(boards.map(board => board.name)).size === boards.length,
        "Board names must be unique."),
      materialThicknessMm: z.number().positive().finite(),
      powerPct: z.number().min(1).max(100),
      speedMmS: z.number().positive().finite(),
      passes: z.number().int().min(1).max(50)
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, boards, powerPct, speedMmS, passes, materialThicknessMm }) => {
    try {
      return result(await createM2PrintCutProject(projectPath, boards, powerPct, speedMmS, passes, materialThicknessMm));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("studio_convert_dxf_file", {
    description: "Convert a planar DXF drawing to a new XCS project. Preserve geometry in millimeters, including closed outlines and open lines. One processing operation is applied to all contours.",
    inputSchema: {
      dxfPath: localPath(".dxf"),
      projectPath: localPath(".xcs"),
      sourceUnits: dxfUnits.default("auto"),
      curveToleranceMm: z.number().min(0.001).max(0.25).default(0.02),
      machine: z.string().min(1),
      operation: z.enum(["cut", "score", "engrave"]),
      powerPct: z.number().min(0).max(100),
      speedMmS: z.number().min(0.1),
      passes: z.number().int().min(1).max(50),
      materialThicknessMm: z.number().positive().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ dxfPath, projectPath, sourceUnits, curveToleranceMm, machine, operation, powerPct, speedMmS, passes, materialThicknessMm }) => {
    try {
      const model = getMachine(machine);
      if (!model) throw new Error(`Unknown machine: ${machine}. Use list_machines for supported models.`);
      const { design, unitCode } = await loadDxf(dxfPath, sourceUnits, curveToleranceMm, {
        type: operation, power_pct: powerPct, speed_mm_s: speedMmS, passes
      });
      const project = buildXcs(design, { machine: model, materialThicknessMm });
      const validation = validateXcs(project.json);
      if (!validation.valid) throw new Error(validation.errors.join(" "));
      await writeFile(projectPath, project.json, { encoding: "utf8", flag: "wx" });
      return result({
        projectPath, machine: project.extName, unitCode, curveToleranceMm,
        widthMm: design.widthMm, heightMm: design.heightMm, contourCount: design.shapes.length,
        warnings: project.warnings, validation
      });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("studio_inspect_project", {
    description: "Read a local XCS or Studio XS v2 project and list its canvases, active processing modes, and shape geometry in millimeters. On M2, FREE_COMBINATION is Print then Cut.",
    inputSchema: { projectPath: localPath(".xcs", ".xs") },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ projectPath }) => {
    try {
      if (extname(projectPath).toLowerCase() === ".xs") return result(await inspectXs(projectPath));
      const document = await readProject(projectPath);
      return result({
        projectPath,
        machine: document.extName ?? document.extId ?? null,
        canvases: document.canvas.map(canvas => {
          const entries = new Map(processingEntries(document.device, canvas.id));
          return {
            id: canvas.id,
            name: canvas.title ?? canvas.name,
            shapes: canvas.displays.map(({ id, type, name, x, y, width, height, angle, groupTag, layerId }) => {
              const settings = typeof id === "string" ? activeSettings(entries.get(id)) : undefined;
              return {
                id, type, name, x, y, width, height, angle, groupTag, layerId,
                processing: settings && {
                  type: settings.entry.processingType,
                  ignored: settings.entry.processIgnore,
                  material: settings.operation.materialType,
                  powerPct: settings.parameters.power,
                  speedMmS: settings.parameters.speed,
                  passes: settings.parameters.repeat
                }
              };
            })
          };
        }),
        validation: validateXcs(document)
      });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("studio_rename_project_layer", {
    description: "Rename a layer on a saved XS v2 canvas and write a new project revision.",
    inputSchema: {
      projectPath: localPath(".xs"),
      outputPath: localPath(".xs"),
      canvasId: z.string().min(1),
      layerId: z.string().min(1),
      name: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, outputPath, canvasId, layerId, name }) => {
    try {
      return result(await renameXsLayer(projectPath, outputPath, canvasId, layerId, name));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("studio_move_shapes_to_layer", {
    description: "Assign selected shapes to an existing color layer on a saved XS v2 canvas and write a new revision.",
    inputSchema: {
      projectPath: localPath(".xs"),
      outputPath: localPath(".xs"),
      canvasId: z.string().min(1),
      layerId: z.string().min(1),
      shapeIds: z.array(z.string().min(1)).min(1)
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, outputPath, canvasId, layerId, shapeIds }) => {
    try {
      return result(await moveXsShapesToLayer(projectPath, outputPath, canvasId, layerId, shapeIds));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("studio_rename_project_shape", {
    description: "Give a shape identified by its persistent ID a name in a new XS v2 revision.",
    inputSchema: {
      projectPath: localPath(".xs"),
      outputPath: localPath(".xs"),
      canvasId: z.string().min(1),
      shapeId: z.string().min(1),
      name: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, outputPath, canvasId, shapeId, name }) => {
    try {
      return result(await renameXsShape(projectPath, outputPath, canvasId, shapeId, name));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("studio_update_project_settings", {
    description: "Save a new XCS or XS revision with updated power, speed, or passes for selected laser shapes on one canvas.",
    inputSchema: {
      projectPath: localPath(".xcs", ".xs"),
      outputPath: localPath(".xcs", ".xs"),
      canvasId: z.string().min(1),
      shapeIds: z.array(z.string().min(1)).min(1),
      powerPct: z.number().min(0).max(100).optional(),
      speedMmS: z.number().positive().optional(),
      passes: z.number().int().min(1).max(50).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, outputPath, canvasId, shapeIds, powerPct, speedMmS, passes }) => {
    try {
      const patch = {
        ...(powerPct === undefined ? {} : { power: powerPct }),
        ...(speedMmS === undefined ? {} : { speed: speedMmS }),
        ...(passes === undefined ? {} : { repeat: passes })
      };
      if (!Object.keys(patch).length) throw new Error("Specify at least one processing setting.");
      const extension = extname(projectPath).toLowerCase();
      if (extension !== extname(outputPath).toLowerCase()) {
        throw new Error("The input and output project extensions must match.");
      }
      if (extension === ".xs") {
        return result(await updateXsSettings(projectPath, outputPath, canvasId, shapeIds, patch));
      }
      const document = await readProject(projectPath);
      const canvas = document.canvas.find(item => item.id === canvasId);
      if (!canvas) throw new Error(`Unknown canvas: ${canvasId}.`);
      const entries = new Map(processingEntries(document.device, canvasId));
      const ids = new Set(canvas.displays.map(shape => shape.id));
      const uniqueShapeIds = [...new Set(shapeIds)];
      for (const id of uniqueShapeIds) {
        if (!ids.has(id)) throw new Error(`Unknown shape on canvas: ${id}.`);
        const raw = entries.get(id);
        const settings = activeSettings(raw);
        if (!raw || settings?.operation.materialType !== "customize" ||
          !xcsLaserOperations.has(settings.entry.processingType) ||
          (settings.parameters.processHead != null && settings.parameters.processHead !== "LASER")) {
          throw new Error(`Shape ${id} has no supported custom laser processing settings.`);
        }
        // Use parsed values for validation and mutate the original document data to preserve unknown fields.
        const operations = raw.data as Record<string, { parameter: { customize: Record<string, unknown> } }>;
        const parameters = operations[settings.entry.processingType]?.parameter.customize;
        if (!parameters) throw new Error(`Shape ${id} has no editable custom parameters.`);
        Object.assign(parameters, patch);
      }
      document.modify = Date.now();
      const validation = validateXcs(document);
      if (!validation.valid) throw new Error(validation.errors.join(" "));
      await writeFile(outputPath, JSON.stringify(document, null, 2), { encoding: "utf8", flag: "wx" });
      return result({ outputPath, canvasId, updatedShapeIds: uniqueShapeIds, validation });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("studio_convert_svg_file", {
    description: "Convert a local SVG to a new XCS project with explicit machine and processing settings.",
    inputSchema: {
      svgPath: localPath(".svg"),
      projectPath: localPath(".xcs"),
      machine: z.string().min(1),
      operation: z.enum(["cut", "score", "engrave"]),
      powerPct: z.number().min(0).max(100),
      speedMmS: z.number().positive(),
      passes: z.number().int().positive(),
      materialThicknessMm: z.number().positive().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ svgPath, projectPath, machine, operation, powerPct, speedMmS, passes, materialThicknessMm }) => {
    try {
      const model = getMachine(machine);
      if (!model) throw new Error(`Unknown machine: ${machine}. Use list_machines for supported models.`);
      const svg = await readFile(svgPath, "utf8");
      const design = svgToDesign(svg, {
        defaultOp: { type: operation, power_pct: powerPct, speed_mm_s: speedMmS, passes }
      });
      if (!design.shapes.length) throw new Error("No supported vector shapes found in the SVG.");
      const project = buildXcs(design, { machine: model, materialThicknessMm });
      const validation = validateXcs(project.json);
      if (!validation.valid) throw new Error(validation.errors.join(" "));
      await writeFile(projectPath, project.json, { encoding: "utf8", flag: "wx" });
      return result({ projectPath, machine: project.extName, shapeCount: design.shapes.length, warnings: project.warnings, validation });
    } catch (error) {
      return failure(error);
    }
  });
}

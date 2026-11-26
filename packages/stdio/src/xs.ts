import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";
import { printCutMode } from "./print-cut.js";

const record = z.object({}).passthrough();
const moduleId = z.string().regex(/^[A-Za-z0-9_-]+$/);
const projectSchema = record.extend({
  __v2__: z.literal(true),
  activeCanvasId: moduleId,
  activeDeviceId: moduleId.optional(),
  modules: z.object({ canvases: z.array(moduleId), devices: z.array(moduleId) })
});
const layerSchema = record.extend({
  name: z.string(),
  order: z.number(),
  visible: z.boolean()
});
const canvasSchema = record.extend({
  id: moduleId,
  title: z.string(),
  layerData: z.record(layerSchema).default({}),
  chunkLayout: z.object({ chunkIndexes: z.array(z.number().int().nonnegative()) }).optional()
});
const chunkSchema = record.extend({
  canvasId: moduleId,
  chunkIndex: z.number().int().nonnegative(),
  displays: z.array(record)
});
const profilesSchema = z.object({
  profiles: z.record(z.object({ processingType: z.string(), values: record }))
});
const bindingSchema = record.extend({
  bindingId: z.string(),
  baseProfileId: z.string(),
  displayIds: z.array(z.string()),
  patchIds: z.array(z.string()).optional(),
  shadowOf: z.string().optional()
});
const processingSchema = z.record(record.extend({
  activeMode: z.string(),
  modes: z.record(record.extend({
    ignoredDisplayIds: z.array(z.string()).optional(),
    bindings: z.array(bindingSchema),
    patches: z.record(record.extend({ profileId: z.string(), overrides: record })).optional()
  }))
}));

type Profiles = z.infer<typeof profilesSchema>["profiles"];
type Processing = z.infer<typeof processingSchema>[string];

function canvasSettings(processing: Processing | undefined, profiles: Profiles) {
  const mode = processing?.modes[processing.activeMode];
  const settings = new Map<string, Record<string, unknown>[]>();
  const ignored = new Set(mode?.ignoredDisplayIds);
  for (const binding of mode?.bindings ?? []) {
    const profile = profiles[binding.baseProfileId];
    if (binding.shadowOf || !profile) continue;
    const values = { ...profile.values };
    let resolved = true;
    for (const id of binding.patchIds ?? []) {
      const patch = mode?.patches?.[id];
      if (!patch || patch.profileId !== binding.baseProfileId) {
        resolved = false;
        break;
      }
      Object.assign(values, patch.overrides);
    }
    if (!resolved) continue;
    for (const id of binding.displayIds) {
      const operations = settings.get(id) ?? [];
      operations.push({
        type: profile.processingType,
        bindingId: binding.bindingId,
        ignored: ignored.has(id),
        ...(values.processHead === "PRINTER"
          ? { printerPower: values.power }
          : { powerPct: values.power }),
        speedMmS: values.speed,
        passes: values.repeat,
        processHead: values.processHead,
        laserModule: values.laser
      });
      settings.set(id, operations);
    }
  }
  return { mode: processing?.activeMode, settings, ignored };
}

async function readArchive(path: string) {
  const bytes = await readFile(path);
  const archive = unzipSync(bytes);
  if (!archive[".format"] || strFromU8(archive[".format"]) !== "v2") {
    throw new Error("Expected an xTool Studio XS v2 archive.");
  }
  return archive;
}

function member(archive: Record<string, Uint8Array>, name: string): unknown {
  const bytes = archive[name];
  if (!bytes) throw new Error(`Missing XS archive member: ${name}`);
  return JSON.parse(strFromU8(bytes));
}

function readCanvas(archive: Record<string, Uint8Array>, id: string) {
  const canvas = canvasSchema.parse(member(archive, `canvases/${id}.json`));
  if (canvas.id !== id) throw new Error(`XS canvas ID mismatch: ${id}`);
  return canvas;
}

function readChunk(archive: Record<string, Uint8Array>, id: string, index: number) {
  const chunk = chunkSchema.parse(member(archive, `canvases/${id}/displays-${index}.json`));
  if (chunk.canvasId !== id || chunk.chunkIndex !== index) {
    throw new Error(`XS display chunk identity mismatch: ${id}/${index}`);
  }
  return chunk;
}

export async function inspectXs(path: string) {
  const archive = await readArchive(path);
  const project = projectSchema.parse(member(archive, "project.json"));
  const activeDevice = project.activeDeviceId && project.modules.devices.includes(project.activeDeviceId)
    ? record.parse(member(archive, `devices/device-${project.activeDeviceId}.json`))
    : undefined;
  const profiles = archive["profiles.json"] ? profilesSchema.parse(member(archive, "profiles.json")).profiles : {};
  const processing = activeDevice?.processing === undefined ? {} : processingSchema.parse(activeDevice.processing);
  return {
    projectPath: path,
    format: "xs-v2",
    projectName: project.projectName,
    activeCanvasId: project.activeCanvasId,
    activeDeviceId: project.activeDeviceId,
    machine: activeDevice?.extName ?? activeDevice?.extId ?? null,
    laserPowerW: activeDevice?.power,
    canvases: project.modules.canvases.map(id => {
      const canvas = readCanvas(archive, id);
      const { mode, settings, ignored } = canvasSettings(processing[id], profiles);
      const shapes = (canvas.chunkLayout?.chunkIndexes ?? []).flatMap(index => {
        const chunk = readChunk(archive, id, index);
        return chunk.displays.map(({ id, type, name, x, y, width, height, angle, layerTag, layerColor, groupTags, visible }) => {
          const operations = typeof id === "string" ? settings.get(id) : undefined;
          return {
            id, type, name, x, y, width, height, angle, layerTag, layerColor, groupTags, visible,
            processing: operations?.length === 1 ? operations[0] : undefined,
            operations,
            ignored: typeof id === "string" && ignored.has(id)
          };
        });
      });
      return { id, name: canvas.title, layers: canvas.layerData, mode,
        ...(activeDevice?.extId === "JS002" && mode === printCutMode && { modeName: "Print then Cut" }), shapes };
    })
  };
}

export async function updateXsSettings(
  path: string, outputPath: string, canvasId: string, shapeIds: string[],
  changes: { power?: number; speed?: number; repeat?: number }
) {
  const archive = await readArchive(path);
  const project = projectSchema.parse(member(archive, "project.json"));
  if (!project.modules.canvases.includes(canvasId)) throw new Error(`Unknown XS canvas: ${canvasId}`);
  const deviceId = project.activeDeviceId;
  if (!deviceId || !project.modules.devices.includes(deviceId)) throw new Error("No active XS device.");
  const devicePath = `devices/device-${deviceId}.json`;
  const device = record.parse(member(archive, devicePath));
  const profiles = profilesSchema.parse(member(archive, "profiles.json")).profiles;
  const processing = processingSchema.parse(device.processing);
  const canvas = processing[canvasId];
  const mode = canvas?.modes[canvas.activeMode];
  if (!mode) throw new Error("The selected canvas has no active processing mode.");

  const selected = new Set(shapeIds);
  const geometry = readCanvas(archive, canvasId);
  const displayIds = new Set((geometry.chunkLayout?.chunkIndexes ?? []).flatMap(index =>
    readChunk(archive, canvasId, index).displays.map(display => display.id)));
  const { settings } = canvasSettings(canvas, profiles);
  const targets = new Map<string, Set<string>>();
  for (const id of selected) {
    if (!displayIds.has(id)) throw new Error(`Unknown shape on XS canvas: ${id}.`);
    const laser = settings.get(id)?.filter(operation => operation.processHead === "LASER") ?? [];
    if (laser.length !== 1 || typeof laser[0]?.bindingId !== "string") {
      throw new Error(`Shape ${id} must have exactly one resolved laser operation.`);
    }
    const bindingId = laser[0].bindingId;
    const ids = targets.get(bindingId) ?? new Set<string>();
    ids.add(id);
    targets.set(bindingId, ids);
  }

  const originalBindings = [...mode.bindings];
  const patches = mode.patches ?? (mode.patches = {});
  for (const binding of originalBindings) {
    const ids = targets.get(binding.bindingId);
    if (!ids) continue;
    const patchId = `patch:${randomUUID()}`;
    const overrides = Object.assign({}, ...(binding.patchIds ?? []).map(id => patches[id]?.overrides), changes);
    patches[patchId] = { id: patchId, profileId: binding.baseProfileId, source: "custom", overrides };
    const displayIds = binding.displayIds.filter(id => ids.has(id));
    if (displayIds.length === binding.displayIds.length) {
      binding.patchIds = [patchId];
      continue;
    }
    const bindingId = `binding:${randomUUID()}`;
    mode.bindings.push({ ...binding, bindingId, displayIds, patchIds: [patchId] });
    for (const shadow of originalBindings.filter(item => item.shadowOf === binding.bindingId)) {
      mode.bindings.push({ ...shadow, bindingId: `binding:${randomUUID()}`, shadowOf: bindingId });
    }
    binding.displayIds = binding.displayIds.filter(id => !ids.has(id));
  }

  archive[devicePath] = strToU8(JSON.stringify({ ...device, processing }));
  await writeFile(outputPath, zipSync(archive), { flag: "wx" });
  return { outputPath, canvasId, updatedShapeIds: [...selected] };
}

export async function renameXsLayer(path: string, outputPath: string, canvasId: string, layerId: string, name: string) {
  const archive = await readArchive(path);
  const project = projectSchema.parse(member(archive, "project.json"));
  if (!project.modules.canvases.includes(canvasId)) throw new Error(`Unknown XS canvas: ${canvasId}`);
  const canvasPath = `canvases/${canvasId}.json`;
  const raw = record.parse(member(archive, canvasPath));
  const canvas = canvasSchema.parse(raw);
  if (canvas.id !== canvasId) throw new Error(`XS canvas ID mismatch: ${canvasId}`);
  if (!Object.hasOwn(canvas.layerData, layerId)) throw new Error(`Unknown XS layer: ${layerId}`);
  const layer = canvas.layerData[layerId]!;
  layer.name = name;
  archive[canvasPath] = strToU8(JSON.stringify({ ...raw, layerData: canvas.layerData }));
  await writeFile(outputPath, zipSync(archive), { flag: "wx" });
  return { outputPath, canvasId, layerId, name };
}

async function reviseXsDisplays(
  path: string, outputPath: string, canvasId: string, shapeIds: string[],
  update: (canvas: z.infer<typeof canvasSchema>) => Record<string, unknown>
) {
  const archive = await readArchive(path);
  const project = projectSchema.parse(member(archive, "project.json"));
  if (!project.modules.canvases.includes(canvasId)) throw new Error(`Unknown XS canvas: ${canvasId}`);
  const canvas = readCanvas(archive, canvasId);
  const changes = update(canvas);

  const pending = new Set(shapeIds);
  const selected = new Set(pending);
  for (const index of canvas.chunkLayout?.chunkIndexes ?? []) {
    const chunkPath = `canvases/${canvasId}/displays-${index}.json`;
    const chunk = readChunk(archive, canvasId, index);
    let changed = false;
    for (const shape of chunk.displays) {
      if (typeof shape.id !== "string" || !selected.has(shape.id)) continue;
      if (!pending.delete(shape.id)) throw new Error(`Duplicate XS shape ID: ${shape.id}`);
      if (Object.entries(changes).every(([key, value]) => shape[key] === value)) continue;
      Object.assign(shape, changes);
      changed = true;
    }
    if (changed) archive[chunkPath] = strToU8(JSON.stringify(chunk));
  }
  if (pending.size) throw new Error(`Unknown shape IDs on canvas: ${[...pending].join(", ")}`);
  await writeFile(outputPath, zipSync(archive), { flag: "wx" });
  return { outputPath, canvasId, shapeIds: [...selected] };
}

export async function moveXsShapesToLayer(
  path: string, outputPath: string, canvasId: string, layerId: string, shapeIds: string[]
) {
  const result = await reviseXsDisplays(path, outputPath, canvasId, shapeIds, canvas => {
    if (!Object.hasOwn(canvas.layerData, layerId)) throw new Error(`Unknown XS layer: ${layerId}`);
    if (!/^#[0-9a-f]{6}$/i.test(layerId)) throw new Error("The destination layer must have a Studio color key.");
    return { layerTag: layerId, layerColor: layerId };
  });
  return { ...result, layerId };
}

export async function renameXsShape(path: string, outputPath: string, canvasId: string, shapeId: string, name: string) {
  const result = await reviseXsDisplays(path, outputPath, canvasId, [shapeId], () => ({ name }));
  return { ...result, name };
}

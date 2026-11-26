/**
 * Structural validator for `.xcs` documents. Not a Studio-grade schema check —
 * it catches the mistakes that most commonly make a hand-built `.xcs` fail to
 * open or render (missing Map markers, display/processing id mismatch, the
 * CIRCLE scale invariant).
 */

export interface XcsValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: string;
}

const KNOWN_TYPES = new Set(["RECT", "LINE", "CIRCLE", "PATH", "PEN", "TEXT", "BITMAP"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validateXcs(input: string | Record<string, unknown>): XcsValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let doc: unknown;
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input) as unknown;
    } catch (e) {
      return {
        valid: false,
        errors: [`Not valid JSON: ${(e as Error).message}`],
        warnings: [],
        summary: "Invalid JSON"
      };
    }
  } else {
    doc = input;
  }

  if (!isRecord(doc)) {
    return { valid: false, errors: ["Expected an XCS object."], warnings, summary: "Invalid .xcs object." };
  }

  const canvasId = doc.canvasId;
  if (typeof canvasId !== "string") errors.push("Missing top-level string `canvasId`.");
  if (typeof doc.extId !== "string") warnings.push("Missing `extId` (machine model code).");

  const canvas = doc.canvas;
  const displayIdsByCanvas = new Map<string, Set<string>>();
  if (!Array.isArray(canvas) || canvas.length === 0) {
    errors.push("`canvas` must be a non-empty array.");
  } else {
    canvas.forEach((item, canvasIndex) => {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id) {
        errors.push(`Canvas[${canvasIndex}] missing string id.`);
        return;
      }
      if (displayIdsByCanvas.has(item.id)) {
        errors.push(`Duplicate canvas id "${item.id}".`);
        return;
      }
      const displayIds = new Set<string>();
      displayIdsByCanvas.set(item.id, displayIds);
      if (!Array.isArray(item.displays)) {
        errors.push(`Canvas "${item.id}" displays must be an array.`);
        return;
      }
      item.displays.forEach((disp, i) => {
        if (!isRecord(disp) || typeof disp.id !== "string" || !disp.id) {
          errors.push(`Canvas "${item.id}" display[${i}] missing string id.`);
          return;
        }
        if (displayIds.has(disp.id)) errors.push(`Canvas "${item.id}" has duplicate display id "${disp.id}".`);
        displayIds.add(disp.id);
        if (typeof disp.type !== "string" || !KNOWN_TYPES.has(disp.type)) {
          warnings.push(`Display[${i}] has unknown type "${String(disp.type)}".`);
        }
        if (disp.type === "CIRCLE") {
          const scale = disp.scale as { x?: number } | undefined;
          const width = disp.width as number | undefined;
          if (scale?.x != null && width != null) {
            const expected = width / 5900;
            if (Math.abs(scale.x - expected) > 1e-4) {
              warnings.push(
                `CIRCLE display[${i}] scale.x=${scale.x} should equal width/5900=${expected.toFixed(6)} or it renders invisible.`
              );
            }
          }
        }
      });
    });
    if (typeof canvasId === "string" && !displayIdsByCanvas.has(canvasId)) {
      errors.push(`Top-level canvasId "${canvasId}" does not match any canvas.`);
    }
  }

  // device.data Map structure + id cross-check.
  const device = doc.device;
  const processedIdsByCanvas = new Map<string, Set<string>>();
  if (!isRecord(device)) {
    errors.push("Missing `device` object.");
  } else {
    const data = device.data;
    if (!isRecord(data) || data.dataType !== "Map" || !Array.isArray(data.value)) {
      errors.push('`device.data` must be `{ "dataType": "Map", "value": [...] }`.');
    } else {
      for (const pair of data.value) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !isRecord(pair[1])) {
          errors.push("Malformed canvas entry inside device.data.");
          continue;
        }
        const [id, canvasProc] = pair;
        if (processedIdsByCanvas.has(id)) {
          errors.push(`Duplicate processing map for canvas "${id}".`);
          continue;
        }
        const processedIds = new Set<string>();
        processedIdsByCanvas.set(id, processedIds);
        if (!displayIdsByCanvas.has(id)) warnings.push(`Processing references unknown canvas "${id}".`);
        const nested = canvasProc.displays;
        if (!isRecord(nested) || nested.dataType !== "Map" || !Array.isArray(nested.value)) {
          errors.push("Nested `displays` Map missing or malformed inside `device.data`.");
          continue;
        }
        for (const inner of nested.value) {
          if (!Array.isArray(inner) || inner.length !== 2 || typeof inner[0] !== "string" || !isRecord(inner[1])) {
            errors.push(`Malformed display processing entry for canvas "${id}".`);
            continue;
          }
          if (processedIds.has(inner[0])) errors.push(`Duplicate processing entry for display "${inner[0]}" on canvas "${id}".`);
          processedIds.add(inner[0]);
        }
      }
    }
  }

  let displayCount = 0;
  let processedCount = 0;
  for (const [canvasKey, displayIds] of displayIdsByCanvas) {
    displayCount += displayIds.size;
    const processedIds = processedIdsByCanvas.get(canvasKey) ?? new Set<string>();
    for (const id of displayIds) {
      if (!processedIds.has(id)) {
        warnings.push(`Display "${id}" on canvas "${canvasKey}" has no processing entry in device.data (it will not be lasered).`);
      } else {
        processedCount++;
      }
    }
    for (const id of processedIds) {
      if (!displayIds.has(id)) {
        warnings.push(`Processing entry references unknown display id "${id}" on canvas "${canvasKey}".`);
      }
    }
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    warnings,
    summary: valid
      ? `Valid .xcs structure: ${displayCount} shape(s), ${processedCount} with processing.`
      : `Invalid .xcs: ${errors.length} error(s).`
  };
}

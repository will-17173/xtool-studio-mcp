import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Design, OpParams } from "@xtool-mcp/core";
import { z } from "zod";

const execute = promisify(execFile);
export const dxfUnits = z.enum(["auto", "mm", "cm", "m", "inch", "foot"]);

const converter = String.raw`
import json
import math
import sys

try:
    import ezdxf
    from ezdxf import path, units
    from ezdxf.xclip import XClip
except ImportError:
    sys.exit("DXF conversion requires Python with ezdxf installed (python -m pip install ezdxf).")

file, requested_units, tolerance = sys.argv[1:]
try:
    document = ezdxf.readfile(file)
    unit_codes = {"mm": 4, "cm": 5, "m": 6, "inch": 1, "foot": 2}
    unit_code = document.units if requested_units == "auto" else unit_codes[requested_units]
    if not unit_code:
        raise ValueError("DXF has no drawing units. Explicitly specify its source units.")
    factor = units.conversion_factor(unit_code, units.MM)
    allowed = {"LINE", "ARC", "CIRCLE", "ELLIPSE", "SPLINE", "LWPOLYLINE", "POLYLINE"}

    def check_source(entities, visited=()):
        for entity in entities:
            kind = entity.dxftype()
            if kind == "INSERT":
                if XClip(entity).has_clipping_path:
                    raise ValueError("Clipped DXF block references must be flattened before conversion.")
                if entity.attribs:
                    raise ValueError("Unsupported DXF entities: ATTRIB")
                block = entity.block()
                if block is None or block.name in visited or len(visited) >= 32:
                    raise ValueError("Missing, recursive or deeply nested DXF block: " + entity.dxf.name)
                check_source(block, (*visited, block.name))
            elif kind not in allowed:
                raise ValueError("Unsupported DXF entities: " + kind)

    def skipped(entity, reason):
        raise ValueError("Cannot expand DXF " + entity.dxftype() + ": " + reason)

    def cutting_entities(entities):
        for entity in entities:
            if entity.dxftype() == "INSERT":
                inserts = entity.multi_insert() if entity.mcount > 1 else [entity]
                for insert in inserts:
                    yield from cutting_entities(insert.virtual_entities(skipped_entity_callback=skipped))
            else:
                yield entity

    model = document.modelspace()
    check_source(model)
    contours = []
    unsupported = set()
    point_count = 0
    for entity in cutting_entities(model):
        kind = entity.dxftype()
        if kind not in allowed or (kind == "POLYLINE" and not entity.is_2d_polyline and not entity.is_3d_polyline):
            unsupported.add(kind)
            continue
        curve = path.make_path(entity)
        for part in curve.sub_paths() if curve.has_sub_paths else [curve]:
            points = list(part.flattening(float(tolerance) / factor, segments=8))
            if len(points) < 2:
                raise ValueError("Found a degenerate " + kind + " entity.")
            if not all(math.isfinite(v) for point in points for v in point):
                raise ValueError("DXF contains non-finite coordinates.")
            if max(p.z for p in points) - min(p.z for p in points) > 1e-5 / factor:
                raise ValueError("Found geometry outside the XY cutting plane.")
            closed = kind == "CIRCLE" or part.is_closed
            if closed and points[-1].isclose(points[0]):
                points.pop()
            if len(points) < (3 if closed else 2):
                raise ValueError("Found a degenerate " + kind + " contour.")
            point_count += len(points)
            if point_count > 250000:
                raise ValueError("DXF exceeds the 250,000-point conversion limit.")
            contours.append({"closed": closed, "points": [[p.x * factor, p.y * factor] for p in points]})
    if unsupported:
        raise ValueError("Unsupported DXF entities: " + ", ".join(sorted(unsupported)))
    if not contours:
        raise ValueError("No supported contours found in DXF model space.")
    print(json.dumps({"unitCode": unit_code, "contours": contours}, allow_nan=False))
except Exception as error:
    sys.exit(str(error))
`;

const resolvedDxf = z.object({
  unitCode: z.number(),
  contours: z.array(z.object({ closed: z.boolean(), points: z.array(z.tuple([z.number(), z.number()])) }))
});

export async function loadDxf(path: string, sourceUnits: z.infer<typeof dxfUnits>, toleranceMm: number, op: OpParams) {
  let stdout: string;
  try {
    const python = process.env.XTOOL_DXF_PYTHON || (process.platform === "win32" ? "python" : "python3");
    ({ stdout } = await execute(python, [
      "-X", "utf8", "-c", converter, path, sourceUnits, String(toleranceMm)
    ], { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 }));
  } catch (error) {
    const detail = error as { stderr?: string; code?: string; killed?: boolean };
    const message = detail.stderr?.trim();
    if (message) throw new Error(message);
    if (detail.code === "ENOENT") throw new Error("Python was not found. Set XTOOL_DXF_PYTHON to a Python interpreter with ezdxf.");
    throw new Error(detail.killed ? "DXF conversion timed out." : "DXF conversion failed.");
  }

  const { unitCode, contours } = resolvedDxf.parse(JSON.parse(stdout));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { points } of contours) {
    for (const [x, y] of points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const design: Design = {
    widthMm: maxX - minX,
    heightMm: maxY - minY,
    units: "mm",
    shapes: contours.map(({ closed, points }, index) => ({
      id: `dxf-${index + 1}`,
      kind: closed ? "polygon" : "polyline",
      points: points.map(([x, y]) => [x - minX, maxY - y]),
      op
    }))
  };
  return { design, unitCode };
}

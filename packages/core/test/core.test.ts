import { describe, it, expect } from "vitest";
import {
  recommendSettings,
  listMachines,
  getMachine,
  generateTestGrid,
  generateBox,
  buildXcs,
  validateXcs,
  svgToDesign,
  emptyDesign,
  defaultKeywordBackend
} from "../src/index.js";

describe("machines", () => {
  it("loads the catalog and resolves by id/name", () => {
    expect(listMachines().length).toBeGreaterThan(5);
    expect(getMachine("P2")?.category).toBe("co2");
    expect(getMachine("xTool D1 Pro")?.id).toBe("d1-pro");
    // "D1 Pro" must not collapse to plain "D1"; F2 must not collapse to F2 Ultra.
    expect(getMachine("D1 Pro")?.id).toBe("d1-pro");
    expect(getMachine("F2")?.id).toBe("f2");
    expect(getMachine("F2 Ultra")?.id).toBe("f2-ultra");
  });
});

describe("recommendSettings", () => {
  it("matches a wattage-labelled row to the catalog machine", () => {
    const r = recommendSettings({
      machine: "D1 Pro",
      material: "Basswood Plywood",
      thickness_mm: 3,
      operation: "cut"
    });
    expect(r.best).not.toBeNull();
    expect(r.best?.power_pct).toBeGreaterThan(0);
    expect(r.safety.some((s) => /scrap/i.test(s))).toBe(true);
    expect(r.safety.some((s) => /PVC/i.test(s))).toBe(true);
  });

  it("falls back to test-grid guidance when there's no data", () => {
    const r = recommendSettings({ machine: "D1 Pro", material: "unobtainium", operation: "cut" });
    expect(r.best).toBeNull();
    expect(r.guidance).toMatch(/test grid/i);
  });

  it("hard-refuses prohibited materials and never suggests a test grid", () => {
    const r = recommendSettings({ machine: "S1", material: "PVC", operation: "cut" });
    expect(r.prohibited).toBe(true);
    expect(r.best).toBeNull();
    expect(r.guidance).toMatch(/do not laser/i);
    // Must not send the user off to "find settings" via a test grid for a banned material.
    expect(r.guidance).not.toMatch(/find safe values/i);
    expect(r.guidance).not.toMatch(/generate_test_grid/i);
  });
});

describe("test grid", () => {
  it("produces the right number of cells and a legend", () => {
    const { design, legend } = generateTestGrid({
      xParam: "power",
      xValues: [100, 80, 60],
      yParam: "speed",
      yValues: [10, 20],
      operation: "engrave"
    });
    expect(legend.length).toBe(6);
    const rects = design.shapes.filter((s) => s.kind === "rect");
    expect(rects.length).toBe(6);
  });

  it("rejects identical axes", () => {
    expect(() =>
      generateTestGrid({ xParam: "power", xValues: [1], yParam: "power", yValues: [1] })
    ).toThrow();
  });
});

describe("finger-joint box", () => {
  it("emits five panels as polygons for an open tray", () => {
    const { design, panels } = generateBox({ width: 120, depth: 80, height: 40, thickness: 3 });
    expect(panels.length).toBe(5);
    expect(design.shapes.every((s) => s.kind === "polygon")).toBe(true);
    expect(design.widthMm).toBeGreaterThan(0);
  });
});

describe(".xcs build + validate", () => {
  it("builds a valid .xcs from a test grid", () => {
    const { design } = generateTestGrid({
      xParam: "power",
      xValues: [100, 80],
      yParam: "speed",
      yValues: [10, 20],
      operation: "engrave"
    });
    const built = buildXcs(design, { machine: "D1 Pro" });
    const v = validateXcs(built.json);
    expect(v.valid).toBe(true);
    expect(v.errors).toHaveLength(0);
  });

  it("applies the CIRCLE scale=width/5900 invariant", () => {
    const d = emptyDesign(50, 50);
    d.shapes.push({
      kind: "ellipse",
      id: "c1",
      cx: 25,
      cy: 25,
      rx: 10,
      ry: 10,
      op: { type: "cut", power_pct: 100, speed_mm_s: 10, passes: 1 }
    });
    const built = buildXcs(d, { machine: "P2" });
    const canvas = (built.doc.canvas as Array<{ displays: Array<Record<string, unknown>> }>)[0];
    const disp = canvas!.displays[0]!;
    expect(disp.type).toBe("CIRCLE");
    const scale = disp.scale as { x: number };
    expect(scale.x).toBeCloseTo(20 / 5900, 6);
    expect(validateXcs(built.json).valid).toBe(true);
  });
});

describe("extId targeting", () => {
  it("uses curated extId codes for known machines (no warning)", () => {
    const d = emptyDesign(30, 30);
    d.shapes.push({
      kind: "rect",
      id: "r",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      op: { type: "cut", power_pct: 100, speed_mm_s: 10, passes: 1 }
    });
    const f2 = buildXcs(d, { machine: "F2 Ultra" });
    expect(f2.extId).toBe("GS004-CLASS-4");
    expect(f2.warnings.length).toBe(0);
    expect(buildXcs(d, { machine: "D1" }).extId).toBe("D1");
    // Unknown machine still derives, and warns.
    expect(buildXcs(d, { machine: "P3" }).warnings.length).toBeGreaterThan(0);
  });
});

describe("SVG import", () => {
  it("parses a rect from an SVG", () => {
    const design = svgToDesign(
      `<svg width="50mm" height="50mm" viewBox="0 0 50 50"><rect x="5" y="5" width="20" height="10"/></svg>`
    );
    expect(design.shapes.length).toBe(1);
    expect(design.shapes[0]?.kind).toBe("rect");
    expect(design.widthMm).toBe(50);
  });

  it("rejects SVG geometry that needs scaling or flattening", () => {
    expect(() => svgToDesign('<svg width="100mm" height="100mm" viewBox="0 0 1000 1000"><rect width="200" height="300"/></svg>'))
      .toThrow(/one drawing unit per millimeter/);
    expect(() => svgToDesign('<svg><g transform="translate(10 20)"><rect width="3" height="4"/></g></svg>'))
      .toThrow(/Flatten SVG/);
    expect(() => svgToDesign('<svg><defs><rect width="3" height="4"/></defs></svg>'))
      .toThrow(/Flatten SVG/);
    expect(() => svgToDesign('<svg><rect width="3" height="4"/><image href="preview.png"/></svg>'))
      .toThrow(/Unsupported SVG element: image/);
  });

  it("keeps open SVG paths open and ignores commented geometry", () => {
    const design = svgToDesign("<svg viewBox='0 0 10 10'><!-- <rect width='5' height='5'/> --><path d='M0 0 L5 5'/><path d='M0 0 L5 5 L10 0 Z'/></svg>");
    const { canvas } = JSON.parse(buildXcs(design).json);
    expect(canvas[0].displays.map((display: { isClosePath: boolean }) => display.isClosePath)).toEqual([false, true]);
  });

  it("calculates bounds for relative segments, curves, and arcs", () => {
    const design = svgToDesign('<svg><path d="M10 10 h10 v5 l-4 -3"/><path d="M0 0 C0 10 10 10 10 0"/><path d="M0 0 A5 5 0 0 1 10 0"/></svg>');
    const { canvas } = JSON.parse(buildXcs(design).json);
    expect(canvas[0].displays).toMatchObject([
      { x: 10, y: 10, width: 10, height: 5 },
      { x: 0, y: 0, width: 10, height: 7.5 },
      { x: 0, y: -5, width: 10, height: 5 }
    ]);
  });
});

describe("XCS validation", () => {
  it("validates processing references within the matching canvas", () => {
    const doc = {
      canvasId: "b", extId: "D1",
      canvas: [
        { id: "a", displays: [{ id: "a1", type: "RECT" }] },
        { id: "b", displays: [{ id: "b1", type: "RECT" }] }
      ],
      device: {
        data: {
          dataType: "Map", value: [
            ["a", { displays: { dataType: "Map", value: [["a1", {}]] } }],
            ["b", { displays: { dataType: "Map", value: [["b1", {}]] } }]
          ]
        }
      }
    };
    expect(validateXcs(doc)).toMatchObject({ valid: true, warnings: [], summary: expect.stringContaining("2 shape(s), 2 with processing") });
    doc.device.data.value[1] = ["b", { displays: { dataType: "Map", value: [["a1", {}]] } }];
    expect(validateXcs(doc).warnings).toEqual([
      expect.stringContaining('Display "b1" on canvas "b" has no processing'),
      expect.stringContaining('unknown display id "a1" on canvas "b"')
    ]);
  });

  it("returns a structured error for null documents or nested displays", () => {
    expect(validateXcs("null").valid).toBe(false);
    expect(validateXcs({
      canvasId: "a", canvas: [{ id: "a", displays: [] }, { id: "b", displays: [null] }],
      device: { data: { dataType: "Map", value: [] } }
    }).errors).toContain('Canvas "b" display[0] missing string id.');
  });
});

describe("input limits & clamping", () => {
  it("caps test-grid cell count", () => {
    expect(() =>
      generateTestGrid({
        xParam: "power",
        xValues: Array.from({ length: 30 }, (_, i) => i),
        yParam: "speed",
        yValues: Array.from({ length: 20 }, (_, i) => i)
      })
    ).toThrow(/400 cells/);
  });

  it("caps box dimensions", () => {
    expect(() => generateBox({ width: 2000, depth: 100, height: 100, thickness: 3 })).toThrow(/1500mm/);
  });

  it("clamps out-of-range op params in the .xcs", () => {
    const d = emptyDesign(20, 20);
    d.shapes.push({
      kind: "rect",
      id: "r",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      op: { type: "cut", power_pct: 150, speed_mm_s: 0, passes: 0 }
    });
    const built = buildXcs(d, { machine: "D1 Pro" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cz = (built.doc as any).device.data.value[0][1].displays.value[0][1].data.VECTOR_CUTTING
      .parameter.customize;
    expect(cz.power).toBe(100);
    expect(cz.speed).toBeGreaterThan(0);
    expect(cz.repeat).toBeGreaterThanOrEqual(1);
  });
});

describe("keyword search", () => {
  it("finds troubleshooting content", async () => {
    const kb = defaultKeywordBackend();
    const hits = await kb.search("laser not cutting through", 3);
    expect(hits.length).toBeGreaterThan(0);
  });
});

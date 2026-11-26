import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { strToU8, zipSync } from "fflate";
import { registerProjectTools } from "../src/projects.js";
import { updateXsSettings } from "../src/xs.js";

test("M2 SVG revisions use the observed Studio model code and 10W default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "studio-project-test-"));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "project-tests", version: "1" });
  const client = new Client({ name: "project-test-client", version: "1" });
  registerProjectTools(server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const svgPath = join(dir, "fixture.svg");
    const projectPath = join(dir, "fixture.xcs");
    await writeFile(svgPath, '<svg width="20mm" height="10mm" viewBox="0 0 20 10"><rect width="20" height="10"/></svg>');
    const converted = await client.callTool({
      name: "studio_convert_svg_file",
      arguments: { svgPath, projectPath, machine: "M2", operation: "cut", powerPct: 10, speedMmS: 20, passes: 1 }
    });
    assert.ok(!converted.isError, JSON.stringify(converted));
    const document = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(document.extId, "JS002");
    assert.equal(document.device.power, 10);

    const entry = document.device.data.value[0][1].displays.value[0][1];
    const custom = entry.data.VECTOR_CUTTING;
    entry.processingType = "INK_PRINT";
    entry.data = { INK_PRINT: custom };
    const printerPath = join(dir, "printer.xcs");
    await writeFile(printerPath, JSON.stringify(document));
    const rejected = await client.callTool({
      name: "studio_update_project_settings",
      arguments: {
        projectPath: printerPath,
        outputPath: join(dir, "printer_revision.xcs"),
        canvasId: document.canvasId,
        shapeIds: [document.canvas[0].displays[0].id],
        speedMmS: 12
      }
    });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /custom laser/);
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("XS revisions reject stale processing bindings with no matching shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "studio-xs-test-"));
  try {
    const projectPath = join(dir, "stale.xs");
    const outputPath = join(dir, "revised.xs");
    const json = (value: unknown) => strToU8(JSON.stringify(value));
    await writeFile(projectPath, zipSync({
      ".format": strToU8("v2"),
      "project.json": json({
        __v2__: true, activeCanvasId: "canvas", activeDeviceId: "device",
        modules: { canvases: ["canvas"], devices: ["device"] }
      }),
      "canvases/canvas.json": json({ id: "canvas", title: "Test" }),
      "profiles.json": json({ profiles: { profile: { processingType: "VECTOR_CUTTING", values: { processHead: "LASER" } } } }),
      "devices/device-device.json": json({
        processing: { canvas: { activeMode: "laser", modes: { laser: { bindings: [
          { bindingId: "binding", baseProfileId: "profile", displayIds: ["missing"] }
        ] } } } }
      })
    }));
    await assert.rejects(updateXsSettings(projectPath, outputPath, "canvas", ["missing"], { speed: 5 }), /Unknown shape/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

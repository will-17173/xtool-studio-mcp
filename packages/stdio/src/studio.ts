import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, normalize, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { closeProjectScript, editorSnapshotScript, moveObjectToLayerScript, previewScript, renameLayerScript, saveProjectScript, selectLayerScript, selectObjectScript, setSelectionParameterScript, summarizeEditors } from "./editor.js";
import { withDesktopLock } from "./desktop-lock.js";
import { openMacStudioProject, runMacStudio, type MacAction } from "./macos.js";

const execute = promisify(execFile);
const scriptReader = Buffer.from(
  "& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))", "utf16le"
).toString("base64");

function runStudioScript(script: string, timeout: number) {
  const task = execute("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", scriptReader
  ], { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
  task.child.stdin?.on("error", () => {});
  // Encode the script as ASCII so both Windows PowerShell and Node agree on input encoding.
  const encoded = Buffer.from(script, "utf8").toString("base64");
  task.child.stdin?.end("& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
    encoded + "'))))");
  return task;
}
function studioError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  if ("cmd" in error) {
    if ("killed" in error && error.killed) return "Studio accessibility operation timed out. Check the current editor state before retrying.";
    return "The Windows Studio integration command failed. Check that Studio is responding.";
  }
  return error.message;
}

const statusScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$windows = @(
  Get-Process -Name 'xTool Studio' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path } |
    ForEach-Object {
      [ordered]@{
        processId = $_.Id
        title = $_.MainWindowTitle
        version = (Get-Item -LiteralPath $_.Path).VersionInfo.ProductVersion
      }
    }
)
[ordered]@{ running = ($windows.Count -gt 0); windows = $windows } |
  ConvertTo-Json -Depth 4 -Compress
`;

async function editorSnapshot(timeout = 12000) {
  if (process.platform === "darwin") return await runMacStudio("snapshot", {}, timeout) as ReturnType<typeof summarizeEditors>;
  if (process.platform !== "win32") throw new Error("Studio desktop integration requires Windows or macOS.");
  const { stdout } = await runStudioScript(editorSnapshotScript, timeout);
  return summarizeEditors(JSON.parse(stdout));
}

function projectPathKey(path: string) {
  if (process.platform !== "win32") return normalize(path).normalize("NFC");
  return win32.normalize(path).replace(/^(\\\\\?\\)(?=[a-z]:)/i, "").toLowerCase();
}

async function desktopAction(action: MacAction, parameters: Record<string, unknown>, windowsScript: () => string, timeout = 12000): Promise<string> {
  if (process.platform === "darwin") return await runMacStudio(action, parameters, timeout);
  if (process.platform !== "win32") throw new Error("Studio desktop integration requires Windows or macOS.");
  return (await runStudioScript(windowsScript(), timeout)).stdout.trim();
}

function liveShapeName(shapeName: string | undefined, shapeId: string | undefined) {
  if (shapeId !== undefined) {
    throw new Error("Studio does not expose persistent shape IDs in its live editor. Use the visible unique shapeName or an offline XS revision tool for an ID-based edit.");
  }
  if (!shapeName?.trim()) throw new Error("Provide a unique shapeName as displayed in Studio's Objects panel.");
  return shapeName;
}

export function registerStudioTools(server: McpServer): void {
  const readEditors = async (includeCanvas: boolean): Promise<CallToolResult> => {
    try {
      const snapshot = await editorSnapshot();
      const editors = includeCanvas ? snapshot : snapshot.map(({ processId, active, title, device, connection }) =>
        ({ processId, active, title, device, connection }));
      return {
        structuredContent: { editors },
        content: [{ type: "text", text: JSON.stringify({ editors }) }]
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: studioError(error) }] };
    }
  };
  const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
  server.registerTool("studio_device_status", {
    description: "Read the device connection indicator in open Studio project editors via desktop accessibility.",
    annotations: readOnly
  }, () => readEditors(false));
  server.registerTool("studio_list_editors", {
    description: "List live Studio project tabs and any exposed local path, canvas zoom, processing mode, and material.",
    annotations: readOnly
  }, () => readEditors(true));

  const closeProjects = async (projectPath?: string, discard = false): Promise<CallToolResult> => {
    const deadline = performance.now() + 50000;
    try {
      if (process.platform !== "win32") throw new Error("Closing Studio project tabs is currently supported on Windows.");
      if (projectPath !== undefined && !isAbsolute(projectPath)) throw new Error("Provide an absolute project path.");
      return await withDesktopLock(async () => {
        const snapshot = await editorSnapshot();
        const targets = projectPath === undefined ? snapshot : snapshot.filter(editor =>
          editor.projectPath && projectPathKey(editor.projectPath) === projectPathKey(projectPath));
        const identity = (editor: typeof snapshot[number]) => ({
          title: editor.title, projectPath: editor.projectPath
        });
        const closed: ReturnType<typeof identity>[] = [];
        let remaining = snapshot;
        let status = "closed";
        let stoppedAt: ReturnType<typeof identity> | null = null;
        let message: string | undefined;
        if (projectPath !== undefined && targets.length !== 1) {
          status = targets.length ? "ambiguous_project" : "project_not_found";
        } else {
          while (remaining.length && (projectPath === undefined || !closed.length)) {
            const target = projectPath === undefined ? remaining[0]! : targets[0]!;
            if (performance.now() + 20000 >= deadline) {
              status = "partial";
              message = "Time budget reached. Call again to close the remaining tabs.";
              break;
            }
            stoppedAt = identity(target);
            if (remaining.filter(editor => editor.title === target.title).length !== 1) {
              status = "ambiguous_or_changed_tab";
              break;
            }
            let next: typeof snapshot;
            try {
              const { stdout } = await runStudioScript(closeProjectScript(target.projectPath, target.title, discard), 12000);
              status = stdout.trim();
              if (!["invoked", "discarded", "pending_discarded"].includes(status)) break;
              await delay(250);
              next = await editorSnapshot(7000);
            } catch (error) {
              status = "closure_unconfirmed";
              message = studioError(error);
              break;
            }
            const removed = remaining.filter(editor => !next.some(item =>
              item.processId === editor.processId && item.title === editor.title && item.projectPath === editor.projectPath));
            if (next.length !== remaining.length - 1 || removed.length !== 1 ||
                (status !== "pending_discarded" && removed[0] !== target)) {
              remaining = next;
              status = "closure_unconfirmed";
              break;
            }
            remaining = next;
            closed.push(identity(removed[0]!));
            stoppedAt = null;
            status = "closed";
          }
        }
        const result = { status, closed, remaining: remaining.map(identity), stoppedAt, message };
        return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
      });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: studioError(error) }] };
    }
  };
  const closeAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  server.registerTool("studio_close_project", {
    description: "Close the Studio tab matching an absolute project path on Windows. Leaves any Studio save prompt open for the user.",
    inputSchema: { projectPath: z.string().min(1) },
    annotations: closeAnnotations
  }, ({ projectPath }) => closeProjects(projectPath));
  server.registerTool("studio_close_all_projects", {
    description: "Close open Studio project tabs on Windows. Stops at save prompts by default. Pass onUnsaved: discard only when explicitly authorized to discard all unsaved project changes.",
    inputSchema: { onUnsaved: z.enum(["stop", "discard"]).default("stop") },
    annotations: closeAnnotations
  }, ({ onUnsaved }) => closeProjects(undefined, onUnsaved === "discard"));

  server.registerTool("studio_move_live_shape_to_layer", {
    description: "Move a shape with a unique visible name to an existing layer in the foreground Studio editor.",
    inputSchema: { projectPath: z.string(), shapeName: z.string().min(1).max(255).optional(), shapeId: z.string().optional(), layerName: z.string().min(1).max(120) },
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ projectPath, shapeName, shapeId, layerName }) => {
    try {
      return await withDesktopLock(async () => {
        if (!isAbsolute(projectPath) || extname(projectPath).toLowerCase() !== ".xs") {
          throw new Error("Provide an absolute path ending in .xs.");
        }
        const name = liveShapeName(shapeName, shapeId);
        const expected = projectPathKey(projectPath);
        const editors = await editorSnapshot();
        const editor = editors.find(item => item.active && item.projectPath && projectPathKey(item.projectPath) === expected);
        const layers = editor?.canvas.layers?.filter(layer => layer.name === layerName);
        if (layers?.length !== 1) {
          throw new Error("Open the Layers and Objects panel on the foreground project and expose one matching layer.");
        }
        const colorIndex = layers[0]!.colorIndex;
        const status = await desktopAction("moveObject", { path: expected, layerName, colorIndex, name },
          () => moveObjectToLayerScript(expected, layerName, colorIndex, name));
        return {
          isError: status !== "invoked",
          structuredContent: { status, projectPath, shapeName: name, layerName },
          content: [{ type: "text", text: `Studio layer assignment: ${status}.` }]
        };
      });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: studioError(error) }] };
    }
  });

  server.registerTool("studio_save_live_project", {
    description: "Save an existing local XS project in the foreground Studio editor and check that the file was updated.",
    inputSchema: { projectPath: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath }) => {
    try {
      return await withDesktopLock(async () => {
        if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("Studio desktop integration requires Windows or macOS.");
        if (!isAbsolute(projectPath) || extname(projectPath).toLowerCase() !== ".xs") {
          throw new Error("Provide an absolute path to an existing local .xs project.");
        }
        const before = await stat(projectPath);
        if (!before.isFile()) throw new Error("Project path must be a regular file.");
        const path = projectPathKey(projectPath);
        let status = await desktopAction("save", { path }, () => saveProjectScript(path));
        if (status === "invoked") {
          const deadline = performance.now() + 6000;
          while (performance.now() < deadline) {
            await delay(250);
            const current = await stat(projectPath).catch(error => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (current && (current.mtimeMs !== before.mtimeMs || current.size !== before.size)) {
              status = "file_updated";
              break;
            }
          }
        }
        return {
          isError: status !== "file_updated" && status !== "invoked",
          structuredContent: { status, projectPath },
          content: [{ type: "text", text: `Studio local save: ${status}.` }]
        };
      });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: studioError(error) }] };
    }
  });

  server.registerTool("studio_select_shape", {
    description: "Select a shape by its unique visible name via the foreground editor's Objects panel.",
    inputSchema: { projectPath: z.string(), shapeName: z.string().min(1).max(255).optional(), shapeId: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, shapeName, shapeId }) => {
    try {
      return await withDesktopLock(async () => {
        if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("Studio desktop integration requires Windows or macOS.");
        if (!isAbsolute(projectPath) || extname(projectPath).toLowerCase() !== ".xs") {
          throw new Error("Provide an absolute path ending in .xs.");
        }
        const name = liveShapeName(shapeName, shapeId);
        const expected = projectPathKey(projectPath);
        const dispatched = await desktopAction("selectObject", { path: expected, name }, () => selectObjectScript(expected, name));
        const editors = dispatched === "invoked" ? await editorSnapshot(5000).catch(() => []) : [];
        const editor = editors.find(item => item.active && item.projectPath && projectPathKey(item.projectPath) === expected);
        const confirmed = editor?.canvas.selectedObjectNames.length === 1 && editor.canvas.selectedObjectNames[0] === name;
        const status = dispatched === "invoked" ? confirmed ? "selection_confirmed" : "selection_unconfirmed" : dispatched;
        return {
          isError: dispatched !== "invoked",
          structuredContent: { status, projectPath, shapeName: name, selection: editor?.canvas.selection ?? null, selectionConfirmed: confirmed },
          content: [{ type: "text", text: `Studio object selection: ${status}.` }]
        };
      });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: studioError(error) }] };
    }
  });

  server.registerTool("studio_rename_live_layer", {
    description: "Rename a layer in the foreground Studio project with its Layers and Objects panel open.",
    inputSchema: {
      projectPath: z.string(),
      layerName: z.string().min(1).max(120),
      newName: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, layerName, newName }) => {
    try {
      return await withDesktopLock(async () => {
        if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("Studio desktop integration requires Windows or macOS.");
        if (!isAbsolute(projectPath) || ![".xs", ".xcs"].includes(extname(projectPath).toLowerCase())) {
          throw new Error("Provide an absolute path ending in .xs or .xcs.");
        }
        const expected = projectPathKey(projectPath);
        let status = await desktopAction("renameLayer", { path: expected, layerName, newName },
          () => renameLayerScript(expected, layerName, newName), 15000);
        if (status === "invoked") {
          const editors = await editorSnapshot(5000);
          const editor = editors.find(item => item.projectPath && projectPathKey(item.projectPath) === expected);
          if (editor?.canvas.layers?.some(layer => layer.name === newName)) status = "rename_confirmed";
        }
        return {
          isError: status !== "rename_confirmed",
          structuredContent: { status, projectPath, layerName, newName },
          content: [{ type: "text", text: `Studio layer rename: ${status}.` }]
        };
      });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: studioError(error) }] };
    }
  });

  server.registerTool("studio_set_selection_parameter", {
    description: "Set one processing field for the current selection in a matching local Studio editor and read the field back.",
    inputSchema: {
      projectPath: z.string(),
      setting: z.discriminatedUnion("parameter", [
        z.object({ parameter: z.literal("powerPct"), value: z.number().min(0).max(100) }),
        z.object({ parameter: z.literal("speedMmS"), value: z.number().positive() }),
        z.object({ parameter: z.literal("passes"), value: z.number().int().min(1).max(50) })
      ])
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ projectPath, setting }) => {
    try {
      return await withDesktopLock(async () => {
        if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("Studio desktop integration requires Windows or macOS.");
        if (!isAbsolute(projectPath) || ![".xs", ".xcs"].includes(extname(projectPath).toLowerCase())) {
          throw new Error("Provide an absolute path ending in .xs or .xcs.");
        }
        const expected = projectPathKey(projectPath);
        let status = await desktopAction("parameter", { path: expected, ...setting },
          () => setSelectionParameterScript(expected, setting.parameter, setting.value));
        let fieldValue: number | null = null;
        if (status === "invoked") {
          const editors = await editorSnapshot(5000);
          const editor = editors.find(item => item.projectPath && projectPathKey(item.projectPath) === expected);
          fieldValue = editor?.canvas.selection?.processing[setting.parameter] ?? null;
          if (fieldValue === setting.value) status = "field_confirmed";
        }
        return {
          isError: status !== "field_confirmed",
          structuredContent: { status, projectPath, ...setting, fieldValue },
          content: [{ type: "text", text: `Studio parameter ${setting.parameter}: ${status}.` }]
        };
      });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: studioError(error) }] };
    }
  });

  server.registerTool("studio_select_layer", {
    description: "Select a named layer in an open Studio project's Layers and Objects panel.",
    inputSchema: { projectPath: z.string(), layerName: z.string().min(1).max(120) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, layerName }) => {
    try {
      return await withDesktopLock(async () => {
        if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("Studio desktop integration requires Windows or macOS.");
        if (!isAbsolute(projectPath) || ![".xs", ".xcs"].includes(extname(projectPath).toLowerCase())) {
          throw new Error("Provide an absolute path ending in .xs or .xcs.");
        }
        const expected = projectPathKey(projectPath);
        let status = await desktopAction("selectLayer", { path: expected, layerName }, () => selectLayerScript(expected, layerName));
        if (status === "invoked") {
          try {
            const editors = await editorSnapshot(5000);
            if (editors.some(editor => editor.projectPath && projectPathKey(editor.projectPath) === expected &&
              editor.canvas.layers?.some(layer => layer.selected && layer.name.toLowerCase() === layerName.toLowerCase()))) {
              status = "selection_confirmed";
            }
          } catch {
            // The accessibility action was dispatched, but read-back was unavailable.
          }
        }
        const accepted = ["invoked", "selection_confirmed", "already_selected"].includes(status);
        return {
          isError: !accepted,
          structuredContent: { status, projectPath, layerName },
          content: [{ type: "text", text: accepted
            ? `Layer "${layerName}": ${status}.`
            : `Unable to select layer "${layerName}" (${status}). Open the Layers and Objects panel on the intended editor.` }]
        };
      });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: studioError(error) }] };
    }
  });

  server.registerTool("studio_open_preview", {
    description: "Request the on-screen processing preview in an open Studio editor identified by its local project path.",
    inputSchema: { projectPath: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath }) => {
    try {
      return await withDesktopLock(async () => {
        if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("Studio desktop integration requires Windows or macOS.");
        if (!isAbsolute(projectPath) || ![".xs", ".xcs"].includes(extname(projectPath).toLowerCase())) {
          throw new Error("Provide an absolute path ending in .xs or .xcs.");
        }
        const path = projectPathKey(projectPath);
        let status = await desktopAction("preview", { path }, () => previewScript(path));
        if (status === "invoked") {
          const expected = projectPathKey(projectPath);
          try {
            const editors = await editorSnapshot(5000);
            if (editors.some(editor => editor.previewOpen && editor.projectPath &&
              projectPathKey(editor.projectPath) === expected)) status = "preview_confirmed";
          } catch {
            // Preserve the observed dispatch result if follow-up accessibility is unavailable.
          }
        }
        const confirmed = status === "preview_confirmed" || status === "already_open";
        const message = confirmed
          ? "Studio shows the processing preview for this project."
          : status === "invoked"
          ? "Studio accepted the Preview button action."
          : status === "ambiguous"
            ? "Studio exposed multiple Preview buttons for the project."
            : "The project editor does not currently expose an enabled Preview button.";
        return {
          isError: !confirmed && status !== "invoked",
          structuredContent: { status, projectPath },
          content: [{ type: "text", text: message }]
        };
      });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: studioError(error) }] };
    }
  });

  server.registerTool("studio_open_project", {
    description: "Open an XS or XCS project using the desktop application and check for an editor tab with that exact path.",
    inputSchema: { projectPath: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath }) => {
    try {
      return await withDesktopLock(async () => {
        if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("Opening Studio projects requires Windows or macOS.");
        if (!isAbsolute(projectPath) || ![".xs", ".xcs"].includes(extname(projectPath).toLowerCase())) {
          throw new Error("Provide an absolute path ending in .xs or .xcs.");
        }
        if (!(await stat(projectPath)).isFile()) throw new Error("The project path must be a regular file.");

        if (process.platform === "darwin") {
          await openMacStudioProject(projectPath);
        } else {
          const script = "$ErrorActionPreference = 'Stop'; Start-Process -FilePath " +
            "'" + projectPath.replaceAll("'", "''") + "'";
          await execute("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")
          ], { windowsHide: true, timeout: 8000 });
        }

        const deadline = performance.now() + 10000;
        const expected = projectPathKey(projectPath);
        let observationError: string | undefined;
        while (deadline - performance.now() > 750) {
          try {
            const editors = await editorSnapshot(Math.ceil(deadline - performance.now()));
            const editor = editors.find(item => item.projectPath && projectPathKey(item.projectPath) === expected);
            if (editor) {
              return {
                structuredContent: { status: "editor_confirmed", projectPath, editor },
                content: [{ type: "text", text: `Studio shows the project tab "${editor.title}" for ${projectPath}.` }]
              };
            }
            observationError = undefined;
          } catch (error) {
            observationError = studioError(error);
            break;
          }
          await delay(350);
        }
        return {
          structuredContent: { status: "request_accepted", projectPath, observationError },
          content: [{ type: "text", text: `The operating system accepted the request for ${projectPath}. Studio has yet to expose a matching editor tab.` }]
        };
      });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: studioError(error) }] };
    }
  });


  server.registerTool(
    "studio_status",
    {
      description: "Find visible xTool Studio windows on this computer and report their titles and installed versions.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        if (process.platform === "darwin") {
          const status = await runMacStudio("status", {}, 8000);
          return { structuredContent: status, content: [{ type: "text", text: JSON.stringify(status) }] };
        }
        if (process.platform !== "win32") throw new Error("Studio desktop integration requires Windows or macOS.");

        const command = Buffer.from(statusScript, "utf16le").toString("base64");
        const { stdout } = await execute(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", command],
          { windowsHide: true, timeout: 8000 }
        );
        const status = JSON.parse(stdout) as Record<string, unknown>;
        return {
          structuredContent: status,
          content: [{ type: "text", text: JSON.stringify(status) }]
        };
      } catch (error) {
        const message = studioError(error);
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    }
  );
}

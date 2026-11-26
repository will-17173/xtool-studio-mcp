import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const bundleId = "com.makeblock.xtool-studio";

const automation = String.raw`
ObjC.import("AppKit");

function read(getter) {
  try { return getter(); } catch (_) { return null; }
}

function attribute(element, name) {
  return read(function () { return element.attributes.byName(name).value(); });
}

function tree(element, depth, nodes) {
  if (!element || depth > 32 || nodes.length >= 3500) return;
  var role = read(function () { return element.role(); }) || "";
  var id = attribute(element, "AXIdentifier");
  var title = read(function () { return element.name(); }) || attribute(element, "AXTitle");
  var value = role === "AXWebArea" || role === "AXDocument"
    ? (attribute(element, "AXURL") || attribute(element, "AXValue"))
    : (role === "AXTextField" || role === "AXStaticText") ? attribute(element, "AXValue") : null;
  nodes.push({ element: element, depth: depth, role: role, id: id, title: title, value: value });
  var children = read(function () { return element.uiElements(); }) || [];
  children.forEach(function (child) { tree(child, depth + 1, nodes); });
}

function projectPath(url) {
  if (typeof url !== "string" || url.indexOf("atomm://renderer/editor/") !== 0) return null;
  var field = /[?&]path=([^&]*)/.exec(url);
  if (!field || !/[?&]type=localClient(?:&|$)/.test(url)) return null;
  return read(function () { return decodeURIComponent(field[1].replace(/\+/g, " ")).normalize("NFC"); });
}

function documents(nodes, windowActive) {
  var output = [];
  nodes.forEach(function (node, index) {
    if (node.role !== "AXWebArea" && node.role !== "AXDocument") return;
    if (typeof node.title !== "string" || !/ - xTool Studio$/.test(node.title)) return;
    var children = [];
    for (var i = index + 1; i < nodes.length && nodes[i].depth > node.depth; i++) children.push(nodes[i]);
    var editor = children.some(function (item) { return item.id === "canvasName" || item.id === "preview"
      || (item.role === "AXButton" && ["Preview", "预览"].indexOf(text(item)) >= 0); });
    var visible = attribute(node.element, "AXVisible");
    output.push({ node: node, children: children, path: projectPath(node.value),
      title: node.title.replace(/ - xTool Studio$/, ""), active: !!(windowActive && editor && visible !== false) });
  });
  return output;
}

function text(node) {
  return typeof node.title === "string" && node.title ? node.title : typeof node.value === "string" ? node.value : "";
}

var connection = {
  "connected": "connected", "已连接": "connected", "disconnected": "disconnected",
  "not connected": "disconnected", "未连接": "disconnected", "connecting": "connecting", "连接中": "connecting"
};

function visibleButton(nodes, id, labels) {
  return nodes.filter(function (node) {
    return node.role === "AXButton" && (node.id === id || labels.indexOf(text(node)) >= 0)
      && attribute(node.element, "AXEnabled") !== false && attribute(node.element, "AXVisible") !== false;
  });
}

function perform(nodes, actionName) {
  if (nodes.length !== 1) return nodes.length ? "ambiguous" : "unavailable";
  var actions = read(function () { return nodes[0].element.actions(); }) || [];
  if (!actions.some(function (action) { return action.name() === actionName; })) return "unavailable";
  nodes[0].element.actions.byName(actionName).perform();
  return "invoked";
}

function press(nodes) { return perform(nodes, "AXPress"); }

function objectLabels(nodes) {
  var index = nodes.findIndex(function (node) {
    return node.role === "AXStaticText" && ["Object List", "对象列表"].indexOf(text(node)) >= 0;
  });
  if (index < 0) return [];
  var depth = nodes[index].depth - 2;
  var matches = [];
  for (var i = index + 1; i < nodes.length && nodes[i].depth > depth; i++) {
    if (nodes[i].role === "AXStaticText" && text(nodes[i])) matches.push(nodes[i]);
  }
  return matches;
}

function namedObjects(nodes, name) {
  return objectLabels(nodes).filter(function (node) { return text(node) === name; });
}

function describedField(nodes, labels) {
  return nodes.filter(function (node) {
    if (node.role !== "AXTextField") return false;
    var desc = attribute(node.element, "AXDescription");
    var label = attribute(node.element, "AXTitle");
    return [text(node), desc, label].some(function (v) { return labels.indexOf(v) >= 0; });
  });
}

function layers(nodes) {
  var output = [];
  nodes.forEach(function (node, index) {
    if (node.role !== "AXRow" && node.role !== "AXOutlineRow") return;
    var labels = [];
    for (var i = index + 1; i < nodes.length && nodes[i].depth > node.depth; i++) {
      if (nodes[i].role === "AXStaticText" && text(nodes[i])) labels.push(text(nodes[i]));
    }
    if (labels.length === 2 && /^\d+$/.test(labels[0])) {
      output.push({ name: labels[1], colorIndex: Number(labels[0]), selected: attribute(node.element, "AXSelected") === true, node: node });
    }
  });
  return output;
}

var fields = { powerPct: ["Power", "功率"], speedMmS: ["Speed", "速度"], passes: ["Passes", "加工次数"] };

function summarize(doc, pid) {
  var labels = doc.children.map(text).filter(Boolean);
  var index = labels.findIndex(function (label) { return Object.prototype.hasOwnProperty.call(connection, label.toLowerCase()); });
  var zoom = labels.find(function (label) { return /^\d+(\.\d+)?%$/.test(label); });
  var processing = {};
  Object.keys(fields).forEach(function (key) {
    var candidates = describedField(doc.children, fields[key]);
    var value = candidates.length === 1 ? String(candidates[0].value || "") : "";
    processing[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
  });
  function adjacent(headings) {
    var i = labels.findIndex(function (label) { return headings.indexOf(label) >= 0; });
    return i >= 0 ? labels[i + 1] || null : null;
  }
  var layerRows = layers(doc.children);
  return { processId: pid, active: doc.active, title: doc.title, projectPath: doc.path,
    controlsAvailable: doc.children.length > 0,
    device: index > 0 ? labels[index - 1] : null,
    connection: index >= 0 ? connection[labels[index].toLowerCase()] : "unknown",
    previewOpen: visibleButton(doc.children, "previewGuide", ["3D Preview Guide", "3D预览使用指引"]).length > 0,
    canvas: { zoomPct: zoom ? parseFloat(zoom) : null, mode: adjacent(["Mode", "模式"]),
      material: adjacent(["Material", "材料"]),
      layers: layerRows.length ? layerRows.map(function (layer) {
        return { name: layer.name, colorIndex: layer.colorIndex, selected: layer.selected };
      }) : null,
      selection: Object.keys(processing).some(function (key) { return processing[key] !== null; })
        ? { multiple: null, boundsMm: null, angleDeg: null, processing: processing } : null,
      selectedObjectNames: objectLabels(doc.children).filter(function (node) {
        return attribute(node.element, "AXSelected") === true;
      }).map(text) } };
}

function run(argv) {
  var request = JSON.parse(argv[0]);
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.bundleId);
  if (Number(apps.count) === 0) return JSON.stringify(request.action === "status" ? { running: false, windows: [] }
    : request.action === "snapshot" ? [] : "studio_not_running");
  var app = apps.objectAtIndex(0);
  var pid = Number(app.processIdentifier);
  var events = Application("System Events");
  var proc = read(function () { return events.applicationProcesses.whose({ unixId: pid })()[0]; });
  if (request.action === "status") {
    var bundle = $.NSBundle.bundleWithURL(app.bundleURL);
    var version = ObjC.unwrap(bundle.objectForInfoDictionaryKey("CFBundleShortVersionString"));
    var windows = proc ? read(function () { return proc.windows(); }) : null;
    return JSON.stringify({ running: true, processId: pid, version: version,
      windowsAvailable: windows !== null,
      windows: (windows || []).map(function (window) {
        return { processId: pid, title: read(function () { return window.name(); }), version: version };
      }) });
  }
  if (!proc || events.UIElementsEnabled() !== true) throw new Error("Allow the MCP host to control System Events and grant it Accessibility access in macOS System Settings.");
  function readDocuments() {
    var output = [];
    proc.windows().forEach(function (window) {
      var nodes = [];
      tree(window, 0, nodes);
      output = output.concat(documents(nodes, proc.frontmost() && attribute(window, "AXMain") === true));
    });
    return output;
  }
  var docs = readDocuments();
  if (request.action === "snapshot") return JSON.stringify(docs.map(function (doc) { return summarize(doc, pid); }));
  var matches = docs.filter(function (doc) { return doc.active && doc.path === request.path; });
  if (matches.length !== 1) return JSON.stringify(matches.length ? "ambiguous" : "project_not_active");
  var doc = matches[0];
  var result = "unavailable";
  switch (request.action) {
    case "preview":
      result = summarize(doc, pid).previewOpen ? "already_open" : press(visibleButton(doc.children, "preview", ["Preview", "预览"]));
      break;
    case "save":
      result = press(visibleButton(doc.children, "saveLocalBtn", ["Save locally", "保存到本地"]));
      if (result === "unavailable" && proc.frontmost() && attribute(doc.node.element, "AXFocused") === true) {
        events.keystroke("s", { using: "command down" });
        result = "invoked";
      }
      break;
    case "selectLayer":
      result = press(layers(doc.children).filter(function (row) { return row.name === request.layerName; })
        .map(function (row) { return row.node; }));
      break;
    case "selectObject":
      result = press(namedObjects(doc.children, request.name));
      break;
    case "renameLayer":
    case "moveObject": {
      var rows = layers(doc.children);
      if (request.action === "moveObject" && rows.filter(function (row) {
        return row.name === request.layerName && row.colorIndex === request.colorIndex;
      }).length !== 1) { result = "layer_unavailable"; break; }
      if (request.action === "renameLayer" && rows.some(function (row) {
        return row.name === request.newName;
      })) { result = "name_exists"; break; }
      var target = request.action === "renameLayer"
        ? rows.filter(function (row) { return row.name === request.layerName; })
          .map(function (row) { return row.node; })
        : namedObjects(doc.children, request.name);
      if (request.action === "moveObject") {
        result = press(target);
        if (result !== "invoked") break;
        var focused = readDocuments().filter(function (item) { return item.active && item.path === request.path; });
        if (focused.length !== 1) { result = "project_not_active"; break; }
        target = namedObjects(focused[0].children, request.name);
      }
      result = perform(target, "AXShowMenu");
      if (result !== "invoked") break;
      var refreshed = readDocuments().filter(function (item) { return item.active && item.path === request.path; });
      if (refreshed.length !== 1) { result = "project_not_active"; break; }
      var items = refreshed[0].children;
      if (request.action === "moveObject") {
        var move = items.findIndex(function (item) {
          return item.role === "AXMenuItem" && /^(Move to |移至 )/.test(text(item));
        });
        var swatches = [];
        for (var i = move + 1; move >= 0 && i < items.length && items[i].depth > items[move].depth; i++) {
          if (text(items[i]) === String(request.colorIndex)) swatches.push(items[i]);
        }
        result = press(swatches);
      } else {
        var rename = items.filter(function (item) {
          return item.role === "AXMenuItem" && ["Rename", "重命名"].indexOf(text(item)) >= 0;
        });
        result = press(rename);
        if (result !== "invoked") break;
        var editors = readDocuments().filter(function (item) { return item.active && item.path === request.path; });
        var inputs = editors.length === 1 ? editors[0].children.filter(function (item) {
          return item.role === "AXTextField" && item.value === request.layerName && attribute(item.element, "AXFocused") === true;
        }) : [];
        if (inputs.length !== 1) { result = "field_unavailable"; break; }
        inputs[0].element.attributes.byName("AXValue").value = request.newName;
        if (!proc.frontmost() || attribute(inputs[0].element, "AXFocused") !== true
          || attribute(inputs[0].element, "AXValue") !== request.newName) {
          result = "field_unconfirmed"; break;
        }
        events.keyCode(36);
      }
      break;
    }
    case "parameter":
      var field = describedField(doc.children, fields[request.parameter] || []);
      if (field.length === 1 && attribute(field[0].element, "AXEnabled") !== false) {
        field[0].element.attributes.byName("AXValue").value = String(request.value);
        result = "invoked";
      }
      break;
  }
  return JSON.stringify(result);
}
`;

export type MacAction = "status" | "snapshot" | "preview" | "save" | "selectLayer" | "parameter"
  | "selectObject" | "renameLayer" | "moveObject";

export async function runMacStudio(action: MacAction, parameters: Record<string, unknown> = {}, timeout = 12000) {
  try {
    const { stdout } = await execute("/usr/bin/osascript", [
      "-l", "JavaScript", "-e", automation, JSON.stringify({ ...parameters, action, bundleId })
    ], { timeout, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const failure = error as { stderr?: string; killed?: boolean };
    if (failure.killed) throw new Error("Studio accessibility operation timed out on macOS.");
    throw new Error(failure.stderr?.trim() || "Could not access xTool Studio on macOS.");
  }
}

export async function openMacStudioProject(path: string) {
  try {
    await execute("/usr/bin/open", ["-b", bundleId, path], { timeout: 8000 });
  } catch {
    throw new Error("macOS could not open the project in xTool Studio. Check that xTool Studio is installed.");
  }
}

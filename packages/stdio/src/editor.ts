export const editorSnapshotScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName Accessibility
Add-Type -ReferencedAssemblies Accessibility -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;

public static class StudioAccessibility {
  [DllImport("oleacc.dll")]
  static extern int AccessibleObjectFromWindow(IntPtr window, uint id, ref Guid iid,
    [MarshalAs(UnmanagedType.Interface)] out IAccessible result);

  [DllImport("oleacc.dll")]
  static extern int AccessibleChildren(IAccessible parent, int start, int count,
    [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] children, out int fetched);

  [StructLayout(LayoutKind.Sequential)]
  struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect bounds);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

  public sealed class Node {
    public int Depth { get; set; }
    public int Role { get; set; }
    public string Name { get; set; }
    public string Value { get; set; }
    public int State { get; set; }
    internal IAccessible Element;
    internal object ChildId;
  }

  static object ReadState(IAccessible element, object childId) {
    try { return element.get_accState(childId); }
    catch (COMException) { return null; }
  }

  static void Walk(IAccessible element, object childId, int depth, List<Node> nodes) {
    if (element == null || depth > 30 || nodes.Count >= 8000) return;
    try {
      object role = element.get_accRole(childId);
      object state = role is int && ((int)role == 36 || (int)role == 41 || (int)role == 42)
        ? ReadState(element, childId) : null;
      nodes.Add(new Node {
        Depth = depth,
        Role = role is int ? (int)role : 0,
        Name = element.get_accName(childId),
        Value = role is int && ((int)role == 15 || (int)role == 42) ? element.get_accValue(childId) : null,
        State = state is int ? (int)state : 0,
        Element = element,
        ChildId = childId
      });
      if ((int)childId != 0) return;
      int count = Math.Min(element.accChildCount, 2000);
      if (count == 0) return;
      int fetched;
      var children = new object[count];
      if (AccessibleChildren(element, 0, count, children, out fetched) < 0) return;
      for (int i = 0; i < fetched; i++) {
        IAccessible nested = children[i] as IAccessible;
        if (nested != null) Walk(nested, 0, depth + 1, nodes);
        else if (children[i] is int) Walk(element, children[i], depth + 1, nodes);
      }
    } catch (COMException) {}
  }

  public static Node[] Read(IntPtr window) {
    Guid iid = typeof(IAccessible).GUID;
    IAccessible root;
    var nodes = new List<Node>();
    const uint objidClient = 0xFFFFFFFC;
    if (AccessibleObjectFromWindow(window, objidClient, ref iid, out root) == 0)
      Walk(root, 0, 0, nodes);
    return nodes.ToArray();
  }

  public static string OpenPreview(IntPtr[] windows, string expectedPath) {
    var matches = new List<Node>();
    foreach (IntPtr window in windows) {
      Node[] nodes = Read(window);
      for (int i = 0; i < nodes.Length; i++) {
        Node document = nodes[i];
        if (document.Role != 15 || !MatchesProject(document.Value, expectedPath)) continue;
        for (int j = i + 1; j < nodes.Length && nodes[j].Depth > document.Depth; j++) {
          Node control = nodes[j];
          if (control.Role == 43 && (control.Name == "3D Preview Guide" ||
            control.Name == "3D\u9884\u89c8\u4f7f\u7528\u6307\u5f15"))
            return "already_open";
          if (control.Role == 43 && (control.Name == "Preview" || control.Name == "\u9884\u89c8"))
            matches.Add(control);
        }
      }
    }
    if (matches.Count != 1) return matches.Count == 0 ? "unavailable" : "ambiguous";
    Node preview = matches[0];
    object state = preview.Element.get_accState(preview.ChildId);
    const int unavailableOrHidden = 0x1 | 0x8000 | 0x10000;
    if (!(state is int) || ((int)state & unavailableOrHidden) != 0) return "unavailable";
    if (String.IsNullOrEmpty(preview.Element.get_accDefaultAction(preview.ChildId))) return "unavailable";
    preview.Element.accDoDefaultAction(preview.ChildId);
    return "invoked";
  }

  public static string SelectLayer(IntPtr[] windows, string expectedPath, string layerName) {
    var matches = new List<Node>();
    foreach (IntPtr window in windows) {
      Node[] nodes = Read(window);
      for (int i = 0; i < nodes.Length; i++) {
        Node document = nodes[i];
        if (document.Role != 15 || !MatchesProject(document.Value, expectedPath)) continue;
        for (int j = i + 1; j < nodes.Length && nodes[j].Depth > document.Depth; j++) {
          Node row = nodes[j];
          if (row.Role != 36) continue;
          var labels = new List<string>();
          for (int k = j + 1; k < nodes.Length && nodes[k].Depth > row.Depth; k++) {
            if (nodes[k].Role == 41 && !String.IsNullOrEmpty(nodes[k].Name)) labels.Add(nodes[k].Name);
          }
          int colorIndex;
          if (labels.Count == 2 && Int32.TryParse(labels[0], out colorIndex) &&
            String.Equals(labels[1], layerName, StringComparison.OrdinalIgnoreCase)) matches.Add(row);
        }
      }
    }
    if (matches.Count != 1) return matches.Count == 0 ? "unavailable" : "ambiguous";
    Node target = matches[0];
    if ((target.State & (0x1 | 0x8000 | 0x10000)) != 0) return "unavailable";
    if ((target.State & 0x2) != 0) return "already_selected";
    if (String.IsNullOrEmpty(target.Element.get_accDefaultAction(target.ChildId))) return "unavailable";
    target.Element.accDoDefaultAction(target.ChildId);
    return "invoked";
  }

  public static string SetSelectionParameter(IntPtr[] windows, string expectedPath, string parameter, string value) {
    string english;
    string chinese;
    switch (parameter) {
      case "powerPct": english = "Power"; chinese = "\u529f\u7387"; break;
      case "speedMmS": english = "Speed"; chinese = "\u901f\u5ea6"; break;
      case "passes": english = "Passes"; chinese = "\u52a0\u5de5\u6b21\u6570"; break;
      default: return "unavailable";
    }
    var matches = new List<Node>();
    foreach (IntPtr window in windows) {
      Node[] nodes = Read(window);
      for (int i = 0; i < nodes.Length; i++) {
        Node document = nodes[i];
        if (document.Role != 15 || !MatchesProject(document.Value, expectedPath)) continue;
        for (int j = i + 1; j < nodes.Length && nodes[j].Depth > document.Depth; j++) {
          Node label = nodes[j];
          if (label.Role != 41 || (label.Name != english && label.Name != chinese)) continue;
          for (int k = j + 1; k < nodes.Length && k <= j + 28 && nodes[k].Depth > document.Depth; k++) {
            Node field = nodes[k];
            if (field.Role == 41 && field.Name != null && !field.Name.StartsWith("(")) break;
            if (field.Role != 42) continue;
            double current;
            if (field.Name == null && Double.TryParse(field.Value,
              System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out current))
              matches.Add(field);
            break;
          }
        }
      }
    }
    if (matches.Count != 1) return matches.Count == 0 ? "unavailable" : "ambiguous";
    Node target = matches[0];
    object state = target.Element.get_accState(target.ChildId);
    if (!(state is int) || ((int)state & (0x1 | 0x40 | 0x8000 | 0x10000)) != 0) return "unavailable";
    target.Element.set_accValue(target.ChildId, value);
    return "invoked";
  }

  static List<Node> LayerLabels(IntPtr window, string path, string name, int role) {
    Node[] nodes = Read(window);
    var result = new List<Node>();
    for (int i = 0; i < nodes.Length; i++) {
      Node document = nodes[i];
      if (document.Role != 15 || !MatchesProject(document.Value, path)) continue;
      for (int j = i + 1; j < nodes.Length && nodes[j].Depth > document.Depth; j++) {
        Node row = nodes[j];
        if (row.Role != 36) continue;
        for (int k = j + 1; k < nodes.Length && nodes[k].Depth > row.Depth; k++) {
          Node node = nodes[k];
          if (node.Role == role && String.Equals(role == 42 ? node.Value : node.Name,
            name, StringComparison.OrdinalIgnoreCase)) result.Add(node);
        }
      }
    }
    return result;
  }

  public static string RenameLayer(IntPtr[] windows, string path, string oldName, string newName) {
    IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      return RenameForegroundLayer(windows, path, oldName, newName);
    } finally {
      if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
    }
  }

  static string RenameForegroundLayer(IntPtr[] windows, string path, string oldName, string newName) {
    IntPtr window = GetForegroundWindow();
    if (Array.IndexOf(windows, window) < 0) return "studio_not_foreground";
    IntPtr editor = ForegroundEditorWindow(window);
    if (editor == IntPtr.Zero) return "editor_unavailable";
    var labels = LayerLabels(editor, path, oldName, 41);
    if (labels.Count != 1) return labels.Count == 0 ? "unavailable" : "ambiguous";
    if (LayerLabels(editor, path, newName, 41).Count > 0) return "name_exists";
    if (ForegroundEditorWindow(window) != editor) return "focus_changed";
    if (!ClickLabel(window, labels[0], 2)) return "unavailable";

    for (int attempt = 0; attempt < 2; attempt++) {
      if (ForegroundEditorWindow(window) != editor) return "focus_changed";
      var fields = LayerLabels(editor, path, oldName, 42);
      if (fields.Count == 1 && (fields[0].State & 0x4) != 0) {
        fields[0].Element.set_accValue(fields[0].ChildId, newName);
        for (int verify = 0; verify < 8; verify++) {
          if (ForegroundEditorWindow(window) != editor) return "focus_changed";
          Node field = fields[0];
          object state = field.Element.get_accState(field.ChildId);
          if (state is int && ((int)state & 0x4) != 0 &&
            field.Element.get_accValue(field.ChildId) == newName) {
            keybd_event(0x0D, 0, 0, UIntPtr.Zero);
            keybd_event(0x0D, 0, 2, UIntPtr.Zero);
            return "invoked";
          }
          System.Threading.Thread.Sleep(100);
        }
        return "field_unconfirmed";
      }
      System.Threading.Thread.Sleep(100);
    }
    return "field_unavailable";
  }

  static bool ClickLabel(IntPtr window, Node label, int count, bool right = false) {
    int left, top, width, height;
    label.Element.accLocation(out left, out top, out width, out height, label.ChildId);
    if (width <= 0 || height <= 0) return false;
    var point = new Point { X = left + width / 2, Y = top + height / 2 };
    if (GetForegroundWindow() != window || GetAncestor(WindowFromPoint(point), 2) != window)
      return false;
    Point original;
    if (!GetCursorPos(out original) || !SetCursorPos(point.X, point.Y)) return false;
    try {
      for (int click = 0; click < count; click++) {
        Point current;
        if (!GetCursorPos(out current) || current.X != point.X || current.Y != point.Y ||
            GetForegroundWindow() != window || GetAncestor(WindowFromPoint(point), 2) != window)
          return false;
        if ((GetAsyncKeyState(0x10) & 0x8000) != 0 || (GetAsyncKeyState(0x11) & 0x8000) != 0 ||
            (GetAsyncKeyState(0x12) & 0x8000) != 0) return false;
        mouse_event(right ? 0x8u : 0x2u, 0, 0, 0, UIntPtr.Zero);
        mouse_event(right ? 0x10u : 0x4u, 0, 0, 0, UIntPtr.Zero);
        if (click + 1 < count) System.Threading.Thread.Sleep(45);
      }
      System.Threading.Thread.Sleep(150);
    } finally { SetCursorPos(original.X, original.Y); }
    return true;
  }

  public static string SelectObject(IntPtr[] windows, string path, string name) {
    IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      IntPtr window = GetForegroundWindow();
      if (Array.IndexOf(windows, window) < 0) return "studio_not_foreground";
      IntPtr editor = ForegroundEditorWindow(window);
      if (editor == IntPtr.Zero) return "editor_unavailable";
      Node[] nodes = Read(editor);
      var matches = new List<Node>();
      for (int i = 0; i < nodes.Length; i++) {
        Node document = nodes[i];
        if (document.Role != 15 || !MatchesProject(document.Value, path)) continue;
        int listDepth = -1;
        for (int j = i + 1; j < nodes.Length && nodes[j].Depth > document.Depth; j++) {
          Node node = nodes[j];
          if (node.Role == 41 && (node.Name == "Object List" || node.Name == "\u5bf9\u8c61\u5217\u8868")) {
            listDepth = node.Depth - 2;
            continue;
          }
          if (listDepth >= 0 && node.Depth <= listDepth) break;
          if (listDepth >= 0 && node.Role == 41 && node.Name == name) matches.Add(node);
        }
      }
      if (matches.Count != 1) return matches.Count == 0 ? "unavailable" : "ambiguous";
      if (ForegroundEditorWindow(window) != editor) return "focus_changed";
      return ClickLabel(window, matches[0], 1) ? "invoked" : "unavailable";
    } finally {
      if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
    }
  }

  public static string SaveProject(IntPtr[] windows, string path) {
    IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      IntPtr window = GetForegroundWindow();
      if (Array.IndexOf(windows, window) < 0) return "studio_not_foreground";
      IntPtr editor = ForegroundEditorWindow(window);
      if (editor == IntPtr.Zero) return "editor_unavailable";
      var documents = new List<Node>();
      foreach (Node node in Read(editor)) {
        if (node.Role == 15 && node.Value != null && node.Value.StartsWith("atomm://renderer/editor/"))
          documents.Add(node);
      }
      if (documents.Count != 1 || !MatchesProject(documents[0].Value, path))
        return "project_not_active";
      if (ForegroundEditorWindow(window) != editor) return "focus_changed";
      keybd_event(0x11, 0, 0, UIntPtr.Zero);
      try {
        keybd_event(0x53, 0, 0, UIntPtr.Zero);
        keybd_event(0x53, 0, 2, UIntPtr.Zero);
      } finally {
        keybd_event(0x11, 0, 2, UIntPtr.Zero);
      }
      return "invoked";
    } finally {
      if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
    }
  }

  public static string MoveObjectToLayer(IntPtr[] windows, string path, string layerName, string colorIndex, string objectName) {
    IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      IntPtr window = GetForegroundWindow();
      if (Array.IndexOf(windows, window) < 0) return "studio_not_foreground";
      IntPtr editor = ForegroundEditorWindow(window);
      if (editor == IntPtr.Zero) return "editor_unavailable";
      Node[] nodes = Read(editor);
      if (Array.FindAll(nodes, node => node.Role == 15 && MatchesProject(node.Value, path)).Length != 1)
        return "project_not_active";

      bool hasLayer = false;
      int listDepth = -1;
      var objects = new List<Node>();
      for (int i = 0; i < nodes.Length; i++) {
        Node node = nodes[i];
        if (node.Role == 36) {
          var labels = new List<string>();
          for (int j = i + 1; j < nodes.Length && nodes[j].Depth > node.Depth; j++) {
            if (nodes[j].Role == 41 && nodes[j].Name != null) labels.Add(nodes[j].Name);
          }
          if (labels.Count == 2 && labels[0] == colorIndex && labels[1] == layerName) hasLayer = true;
        }
        if (node.Role == 41 && (node.Name == "Object List" || node.Name == "\u5bf9\u8c61\u5217\u8868")) {
          listDepth = node.Depth - 2;
          continue;
        }
        if (listDepth >= 0 && node.Depth <= listDepth) listDepth = -1;
        if (listDepth >= 0 && node.Role == 41 && node.Name == objectName) objects.Add(node);
      }
      if (!hasLayer || objects.Count != 1) return "object_or_layer_unavailable";
      if (ForegroundEditorWindow(window) != editor || !ClickLabel(window, objects[0], 1)) return "focus_changed";
      if (ForegroundEditorWindow(window) != editor || !ClickLabel(window, objects[0], 1, true)) return "focus_changed";
      nodes = Read(editor);
      var swatches = new List<Node>();
      for (int i = 0; i < nodes.Length; i++) {
        Node menu = nodes[i];
        if (menu.Role != 12 || menu.Name == null ||
          !(menu.Name.StartsWith("Move to ") || menu.Name.StartsWith("\u79fb\u81f3 "))) continue;
        for (int j = i + 1; j < nodes.Length && nodes[j].Depth > menu.Depth; j++) {
          if (nodes[j].Role == 41 && nodes[j].Name == colorIndex) swatches.Add(nodes[j]);
        }
      }
      if (swatches.Count != 1) return "swatch_unavailable";
      if (ForegroundEditorWindow(window) != editor) return "focus_changed";
      return ClickLabel(window, swatches[0], 1) ? "invoked" : "swatch_unavailable";
    } finally {
      if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
    }
  }

  static IntPtr ForegroundEditorWindow(IntPtr window) {
    Rect bounds;
    if (GetForegroundWindow() != window || !GetWindowRect(window, out bounds)) return IntPtr.Zero;
    var point = new Point {
      X = bounds.Left + (bounds.Right - bounds.Left) / 2,
      Y = bounds.Top + (bounds.Bottom - bounds.Top) / 2
    };
    IntPtr editor = WindowFromPoint(point);
    return editor != window && GetAncestor(editor, 2) == window ? editor : IntPtr.Zero;
  }

  public static Node[] ReadForegroundEditor(IntPtr window) {
    IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      IntPtr editor = ForegroundEditorWindow(window);
      return editor == IntPtr.Zero ? new Node[0] : Read(editor);
    } finally {
      if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
    }
  }

  static Node[] UnsavedControls(Node[] nodes, bool buttons) {
    var matches = new List<Node>();
    for (int i = 0; i < nodes.Length; i++) {
      Node dialog = nodes[i];
      if (dialog.Role != 18) continue;
      if (dialog.Name != "Unsaved changes" && dialog.Name != "\u5185\u5bb9\u672a\u4fdd\u5b58") continue;
      if (!buttons) { matches.Add(dialog); continue; }
      for (int j = i + 1; j < nodes.Length && nodes[j].Depth > dialog.Depth; j++) {
        Node button = nodes[j];
        if (button.Role != 43 || (button.Name != "Don't Save" && button.Name != "Don't save" &&
            button.Name != "\u4e0d\u4fdd\u5b58")) continue;
        object state = ReadState(button.Element, button.ChildId);
        if (state is int && ((int)state & (0x1 | 0x8000 | 0x10000)) == 0 &&
            !String.IsNullOrEmpty(button.Element.get_accDefaultAction(button.ChildId))) matches.Add(button);
      }
    }
    return matches.ToArray();
  }

  public static string CloseProject(IntPtr[] windows, string expectedPath, string title, bool discard) {
    var targets = new List<Node>();
    var pendingDialogs = new List<Node>();
    var pendingButtons = new List<Node>();
    IntPtr targetWindow = IntPtr.Zero;
    int documents = 0;
    foreach (IntPtr window in windows) {
      Node[] nodes = Read(window);
      pendingDialogs.AddRange(UnsavedControls(nodes, false));
      pendingButtons.AddRange(UnsavedControls(nodes, true));
      foreach (Node node in nodes) {
        if (node.Role != 15 || node.Name != title + " - xTool Studio" ||
            !IsEditor(node.Value)) continue;
        if (expectedPath == "" || MatchesProject(node.Value, expectedPath)) documents++;
      }
      // Studio 1.9 exposes the tab strip in the shell document. Its close
      // affordance is an unnamed clickable group immediately after the label.
      for (int i = 1; i + 2 < nodes.Length; i++) {
        Node label = nodes[i], close = nodes[i + 1], icon = nodes[i + 2];
        if (label.Role != 41 || label.Name != title ||
            close.Depth != label.Depth || close.Role != 20 || !String.IsNullOrEmpty(close.Name) ||
            icon.Depth != close.Depth + 1 || icon.Role != 40) continue;
        int row = i - 1;
        while (row >= 0 && nodes[row].Depth >= label.Depth) row--;
        if (row < 0 || nodes[row].Role != 20 || nodes[row].Depth != label.Depth - 1) continue;
        int shell = row - 1;
        while (shell >= 0 && nodes[shell].Role != 15) shell--;
        if (shell < 0 || nodes[shell].Value != "atomm://renderer/shell" ||
            nodes[shell].Depth >= nodes[row].Depth) continue;
        string action = close.Element.get_accDefaultAction(close.ChildId);
        if (action != "Click" && action != "\u70b9\u51fb") continue;
        object state = ReadState(close.Element, close.ChildId);
        if (!(state is int) || ((int)state & (0x1 | 0x8000 | 0x10000)) != 0) continue;
        targets.Add(close);
        targetWindow = window;
      }
    }
    if (pendingDialogs.Count > 0) {
      if (!discard) return "save_prompt_pending";
      if (pendingDialogs.Count != 1 || pendingButtons.Count != 1) return "discard_control_unavailable";
      pendingButtons[0].Element.accDoDefaultAction(pendingButtons[0].ChildId);
      return "pending_discarded";
    }
    if (documents != 1 || targets.Count != 1) return "close_control_unavailable";
    targets[0].Element.accDoDefaultAction(targets[0].ChildId);
    bool discarded = false;
    var deadline = System.Diagnostics.Stopwatch.StartNew();
    while (deadline.ElapsedMilliseconds < 2200) {
      Node[] nodes = Read(targetWindow);
      bool open = Array.Exists(nodes, node => node.Role == 15 &&
        node.Name == title + " - xTool Studio" && IsEditor(node.Value) &&
        (expectedPath == "" || MatchesProject(node.Value, expectedPath)));
      if (!open) return discarded ? "discarded" : "invoked";
      Node[] prompts = UnsavedControls(nodes, false);
      if (prompts.Length > 0 && !discarded) {
        if (!discard) return "save_prompt_pending";
        Node[] buttons = UnsavedControls(nodes, true);
        if (prompts.Length != 1 || buttons.Length != 1) return "discard_control_unavailable";
        buttons[0].Element.accDoDefaultAction(buttons[0].ChildId);
        discarded = true;
      }
      System.Threading.Thread.Sleep(100);
    }
    return discarded ? "discarded" : "invoked";
  }

  static bool IsEditor(string value) {
    Uri uri;
    return Uri.TryCreate(value, UriKind.Absolute, out uri) &&
      uri.Scheme == "atomm" && uri.Host == "renderer" && uri.AbsolutePath == "/editor/";
  }

  static bool MatchesProject(string value, string expectedPath) {
    Uri uri;
    if (!Uri.TryCreate(value, UriKind.Absolute, out uri) ||
      uri.Scheme != "atomm" || uri.Host != "renderer" || uri.AbsolutePath != "/editor/") return false;
    foreach (string parameter in uri.Query.TrimStart('?').Split('&')) {
      if (!parameter.StartsWith("path=", StringComparison.Ordinal)) continue;
      string path = Uri.UnescapeDataString(parameter.Substring(5).Replace("+", " ")).Replace('/', '\\');
      return String.Equals(path, expectedPath, StringComparison.OrdinalIgnoreCase);
    }
    return false;
  }
}
"@
$windows = @(
  Get-Process -Name 'xTool Studio' -ErrorAction SilentlyContinue |
    Where-Object MainWindowHandle -ne 0 |
    ForEach-Object {
      @{
        processId = $_.Id
        nodes = @([StudioAccessibility]::Read($_.MainWindowHandle))
        foregroundNodes = @([StudioAccessibility]::ReadForegroundEditor($_.MainWindowHandle))
      }
    }
)
ConvertTo-Json -InputObject $windows -Depth 5 -Compress
`;

function editorActionScript(path: string) {
  const runtime = editorSnapshotScript.slice(0, editorSnapshotScript.indexOf("$windows = @("));
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  return runtime + String.raw`
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$handles = [IntPtr[]]@(Get-Process -Name 'xTool Studio' -ErrorAction SilentlyContinue |
  Where-Object MainWindowHandle -ne 0 | Select-Object -ExpandProperty MainWindowHandle)
`;
}

export function previewScript(path: string) {
  return editorActionScript(path) + "[StudioAccessibility]::OpenPreview($handles, $path)\n";
}

export function selectLayerScript(path: string, layerName: string) {
  const encodedName = Buffer.from(layerName, "utf8").toString("base64");
  return editorActionScript(path) + String.raw`
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedName}'))
[StudioAccessibility]::SelectLayer($handles, $path, $name)
`;
}

export function setSelectionParameterScript(path: string, parameter: "powerPct" | "speedMmS" | "passes", value: number) {
  return editorActionScript(path) + `[StudioAccessibility]::SetSelectionParameter($handles, $path, '${parameter}', '${value}')\n`;
}

export function renameLayerScript(path: string, oldName: string, newName: string) {
  const original = Buffer.from(oldName, "utf8").toString("base64");
  return editorActionScript(path) + String.raw`
$original = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${original}'))
[StudioAccessibility]::RenameLayer($handles, $path, $original, '${newName}')
`;
}

export function selectObjectScript(path: string, name: string) {
  const encoded = Buffer.from(name, "utf8").toString("base64");
  return editorActionScript(path) + String.raw`
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
[StudioAccessibility]::SelectObject($handles, $path, $name)
`;
}

export function saveProjectScript(path: string) {
  return editorActionScript(path) + "[StudioAccessibility]::SaveProject($handles, $path)\n";
}

export function closeProjectScript(path: string | null, title: string, discard: boolean) {
  const encodedTitle = Buffer.from(title, "utf8").toString("base64");
  return editorActionScript(path ?? "") + String.raw`
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTitle}'))
[StudioAccessibility]::CloseProject($handles, $path, $title, $${discard})
`;
}

export function moveObjectToLayerScript(path: string, name: string, colorIndex: number, objectName: string) {
  const encoded = Buffer.from(name, "utf8").toString("base64");
  const encodedObject = Buffer.from(objectName, "utf8").toString("base64");
  return editorActionScript(path) + String.raw`
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$objectName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedObject}'))
[StudioAccessibility]::MoveObjectToLayer($handles, $path, $name, '${colorIndex}', $objectName)
`;
}

interface AccessibleNode {
  Depth: number;
  Role: number;
  Name: string | null;
  Value: string | null;
  State: number;
}

interface StudioWindow {
  processId: number;
  nodes: AccessibleNode[];
  foregroundNodes: AccessibleNode[];
}

const connectionStates = new Map([
  ["\u672a\u8fde\u63a5", "disconnected"],
  ["\u5df2\u8fde\u63a5", "connected"],
  ["not connected", "disconnected"],
  ["disconnected", "disconnected"],
  ["connected", "connected"],
  ["connecting", "connecting"],
  ["\u8fde\u63a5\u4e2d", "connecting"]
]);

function projectPath(value: string | null): string | null {
  if (!value?.startsWith("atomm://renderer/editor/")) return null;
  const url = new URL(value);
  if (url.searchParams.get("type") !== "localClient") return null;
  return url.searchParams.get("path");
}

function readLayerRows(nodes: AccessibleNode[]) {
  const rows = [];
  for (const [index, node] of nodes.entries()) {
    // ROLE_SYSTEM_OUTLINEITEM
    if (node.Role !== 36) continue;
    const labels: string[] = [];
    for (const child of nodes.slice(index + 1)) {
      if (child.Depth <= node.Depth) break;
      if (child.Role === 41 && child.Name) labels.push(child.Name);
    }
    // Studio labels each layer row with its color index and layer name.
    const [indexLabel, name] = labels;
    if (!indexLabel || !/^\d+$/.test(indexLabel) || !name) continue;
    rows.push({ colorIndex: Number(indexLabel), name, selected: (node.State & 0x2) !== 0 });
  }
  return rows;
}

function readSelection(nodes: AccessibleNode[]) {
  const arrange = nodes.findIndex(node => /^(Arrange|\u6392\u5217)$/i.test(node.Name ?? ""));
  if (arrange < 0) return null;
  const fields = nodes.slice(0, arrange).filter(node => node.Role === 42 && node.Name === null);
  const angleIndex = fields.at(-1)?.Value?.trim().endsWith("°") ? fields.length - 1 : fields.length - 2;
  if (angleIndex < 4 || fields.length - angleIndex > 2) return null;
  const [x, y, width, height, angle] = fields.slice(angleIndex - 4, angleIndex + 1)
    .map(node => node.Value?.trim() ?? "");
  const scalar = /^-?\d+(?:\.\d+)?$/;
  if (!angle?.endsWith("°") ||
    ![x, y, width, height, angle.slice(0, -1)].every(value => scalar.test(value ?? ""))) return null;

  const afterLabel = (label: RegExp) => {
    const index = nodes.findIndex(node => node.Role === 41 && label.test(node.Name ?? ""));
    if (index < 0) return null;
    const value = nodes.slice(index + 1, index + 28).find(node => node.Role === 42)?.Value?.trim();
    return value && scalar.test(value) ? Number(value) : null;
  };
  return {
    multiple: nodes.some(node => /^(Multiple selected objects|\u591a\u4e2a\u9009\u4e2d\u5bf9\u8c61)$/i.test(node.Name ?? "")),
    boundsMm: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) },
    angleDeg: Number(angle.slice(0, -1)),
    processing: {
      powerPct: afterLabel(/^(Power|\u529f\u7387)$/i),
      speedMmS: afterLabel(/^(Speed|\u901f\u5ea6)$/i),
      passes: afterLabel(/^(Passes|\u52a0\u5de5\u6b21\u6570)$/i)
    }
  };
}

function selectedObjectNames(nodes: AccessibleNode[]): string[] {
  const index = nodes.findIndex(node => node.Role === 41 &&
    /^(Object List|\u5bf9\u8c61\u5217\u8868)$/i.test(node.Name ?? ""));
  const heading = nodes[index];
  if (!heading) return [];
  const names: string[] = [];
  for (const node of nodes.slice(index + 1)) {
    if (node.Depth <= heading.Depth - 2) break;
    if (node.Role === 41 && node.Name && (node.State & 0x2) !== 0) names.push(node.Name);
  }
  return names;
}

export function summarizeEditors(windows: StudioWindow[]) {
  return windows.flatMap(({ processId, nodes, foregroundNodes }) => {
    const background = summarizeWindow(processId, nodes, false);
    const foreground = summarizeWindow(processId, foregroundNodes, true);
    return foreground.length === 1
      ? [foreground[0]!, ...background.filter(item => {
        const current = foreground[0]!;
        return item.title !== current.title || item.projectPath !== current.projectPath;
      })]
      : background;
  });
}

function summarizeWindow(processId: number, nodes: AccessibleNode[], active: boolean) {
  const editors = [];
  for (const [index, node] of nodes.entries()) {
    // ROLE_SYSTEM_DOCUMENT
    if (node.Role !== 15 || !node.Name?.endsWith(" - xTool Studio")) continue;
    const controls: AccessibleNode[] = [];
    const descendants: AccessibleNode[] = [];
    for (const descendant of nodes.slice(index + 1)) {
      if (descendant.Depth <= node.Depth) break;
      descendants.push(descendant);
      if (descendant.Name) controls.push(descendant);
    }
    const labels = controls.map(control => control.Name!);
    const connectionIndex = labels.findIndex(label => connectionStates.has(label.trim().toLowerCase()));
    const connectionLabel = labels[connectionIndex];
    const findButtonAfter = (heading: RegExp) => {
      const index = labels.findIndex(label => heading.test(label));
      if (index < 0) return null;
      const next = controls[index + 1];
      return next?.Role === 43 ? next.Name : null;
    };
    const zoom = controls.find(control => control.Role === 43 && /^\d+(\.\d+)?%$/.test(control.Name!));
    editors.push({
      processId,
      active,
      title: node.Name.slice(0, -" - xTool Studio".length),
      projectPath: projectPath(node.Value),
      controlsAvailable: controls.length > 0,
      previewOpen: controls.some(control => control.Role === 43 &&
        /^(3D Preview Guide|3D\u9884\u89c8\u4f7f\u7528\u6307\u5f15)$/i.test(control.Name!)),
      canvas: {
        zoomPct: zoom ? Number.parseFloat(zoom.Name!) : null,
        mode: findButtonAfter(/^(Mode|\u6a21\u5f0f)$/i),
        material: findButtonAfter(/^(Material|\u6750\u6599)$/i),
        selection: readSelection(descendants),
        selectedObjectNames: selectedObjectNames(descendants),
        layers: labels.some(label => /^(Object List|\u5bf9\u8c61\u5217\u8868)$/i.test(label))
          ? readLayerRows(descendants) : null
      },
      device: connectionIndex > 0 ? labels[connectionIndex - 1] : null,
      connection: connectionLabel ? connectionStates.get(connectionLabel.trim().toLowerCase()) : "unknown"
    });
  }
  return editors;
}

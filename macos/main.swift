import Cocoa
import WebKit
import UniformTypeIdentifiers

private let appPort = 18767

private enum WallpaperBridgeError: LocalizedError {
    case invalidPayload
    case invalidImage
    case noScreens
    case noScreensSelected
    case selectedScreenUnavailable
    case originalNotSaved
    case originalUnavailable(String)
    case verificationFailed

    var errorDescription: String? {
        switch self {
        case .invalidPayload: return "앱에서 올바른 배경화면 요청을 받지 못했습니다."
        case .invalidImage: return "현재 미리보기를 PNG 이미지로 만들지 못했습니다."
        case .noScreens: return "연결된 디스플레이를 찾지 못했습니다."
        case .noScreensSelected: return "모니터를 하나 이상 선택해 주세요."
        case .selectedScreenUnavailable: return "선택한 모니터 구성이 바뀌었습니다. 목록을 다시 열어 주세요."
        case .originalNotSaved: return "아직 저장된 원래 배경화면이 없습니다. 먼저 배경화면을 한 번 적용해 주세요."
        case .originalUnavailable(let name): return "\(name)의 원래 배경화면 파일을 찾지 못했습니다."
        case .verificationFailed: return "macOS가 배경화면 변경을 확인하지 못했습니다."
        }
    }
}

private struct OriginalWallpaperSnapshot: Codable {
    let capturedAt: Date
    let screens: [OriginalScreenWallpaper]
}

private struct OriginalScreenWallpaper: Codable {
    let displayID: String
    let displayName: String
    let url: String
    let imageScaling: Int?
    let allowClipping: Bool?
}

private struct WallpaperOperationResult {
    let message: String
    let expectedURLs: [(screen: NSScreen, url: URL)]
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var serverProcess: Process?
    private var outputPipe: Pipe?
    private var outputBuffer = Data()
    private var didLoadApp = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        configureAppIcon()
        createWindow()
        startBundledServer()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            window.makeKeyAndOrderFront(nil)
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "savePNG")
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "wallpaper")
        if let process = serverProcess, process.isRunning {
            process.terminate()
        }
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Schedule Wallpaper 정보", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Schedule Wallpaper 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "파일")
        let closeWindowItem = NSMenuItem(title: "창 닫기", action: #selector(closeMainWindow(_:)), keyEquivalent: "w")
        closeWindowItem.target = self
        fileMenu.addItem(closeWindowItem)
        fileMenuItem.submenu = fileMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func closeMainWindow(_ sender: Any?) {
        window.performClose(sender)
    }

    private func configureAppIcon() {
        let configuredIconFile = Bundle.main.object(forInfoDictionaryKey: "CFBundleIconFile") as? String
        let iconResource = ((configuredIconFile ?? "ScheduleWallpaperIcon.icns") as NSString).deletingPathExtension
        guard let iconURL = Bundle.main.url(forResource: iconResource, withExtension: "icns"),
              let icon = NSImage(contentsOf: iconURL) else {
            NSLog("Schedule Wallpaper: bundled %@.icns could not be loaded", iconResource)
            return
        }
        // A raw AppKit executable does not consistently promote CFBundleIconFile
        // to the running Dock tile, so load the same bundled icon explicitly.
        NSApp.applicationIconImage = icon
    }

    private func createWindow() {
        let contentController = WKUserContentController()
        contentController.add(self, name: "savePNG")
        contentController.add(self, name: "wallpaper")
        let downloadBridge = #"""
        (() => {
          document.documentElement.classList.add('native-app');
          const nativeClick = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function () {
            if (this.download && this.href && this.href.startsWith('data:image/png')) {
              window.webkit.messageHandlers.savePNG.postMessage({ name: this.download, data: this.href });
              return;
            }
            nativeClick.call(this);
          };
        })();
        """#
        contentController.addUserScript(WKUserScript(source: downloadBridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        configuration.websiteDataStore = .default()

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.loadHTMLString("""
        <!doctype html><meta charset="utf-8"><style>
        body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f4ed;color:#64748b;font:14px -apple-system,BlinkMacSystemFont,sans-serif}
        div{text-align:center}strong{display:block;margin-bottom:8px;color:#172033;font-size:18px}
        </style><div><strong>Schedule Wallpaper</strong><span>앱을 여는 중…</span></div>
        """, baseURL: nil)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Schedule Wallpaper"
        window.titlebarAppearsTransparent = false
        window.titleVisibility = .visible
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 760, height: 540)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("ScheduleWallpaperMainWindow")
        window.makeKeyAndOrderFront(nil)
    }

    private func startBundledServer() {
        guard let webDirectory = Bundle.main.resourceURL?.appendingPathComponent("web"),
              FileManager.default.fileExists(atPath: webDirectory.appendingPathComponent("server.py").path) else {
            showStartupError("앱 리소스에서 server.py를 찾지 못했습니다.")
            return
        }

        do {
            let supportDirectory = try prepareSupportDirectory(webDirectory: webDirectory)
            let process = Process()
            let pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["python3", webDirectory.appendingPathComponent("server.py").path, "--serve", "--port", String(appPort)]
            process.currentDirectoryURL = webDirectory
            process.standardOutput = pipe
            process.standardError = pipe
            var environment = ProcessInfo.processInfo.environment
            environment["PYTHONUNBUFFERED"] = "1"
            environment["SCHEDULE_WALLPAPER_DATA_DIR"] = supportDirectory.path
            process.environment = environment
            process.terminationHandler = { [weak self] process in
                guard let self, !self.didLoadApp else { return }
                DispatchQueue.main.async {
                    self.showStartupError("로컬 서버가 시작되지 않았습니다. 포트 \(appPort)이 사용 중인지 확인해 주세요.")
                }
            }
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                self?.consumeServerOutput(data)
            }
            try process.run()
            serverProcess = process
            outputPipe = pipe
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
                guard let self, !self.didLoadApp else { return }
                self.showStartupError("앱 서버 응답이 지연되고 있습니다. 앱을 종료한 뒤 다시 열어 주세요.")
            }
        } catch {
            showStartupError("앱을 시작하지 못했습니다: \(error.localizedDescription)")
        }
    }

    private func prepareSupportDirectory(webDirectory: URL) throws -> URL {
        let directory = try applicationSupportDirectory()
        let destination = directory.appendingPathComponent("conference-deadlines-cache.json")
        let seed = webDirectory.appendingPathComponent("data/conference-deadlines-cache.json")
        if !FileManager.default.fileExists(atPath: destination.path), FileManager.default.fileExists(atPath: seed.path) {
            try FileManager.default.copyItem(at: seed, to: destination)
        }
        return directory
    }

    private func applicationSupportDirectory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("Schedule Wallpaper", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func consumeServerOutput(_ data: Data) {
        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let lineData = outputBuffer.prefix(upTo: newline)
            outputBuffer.removeSubrange(...newline)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }
            if line.contains("Schedule Wallpaper: http://127.0.0.1:\(appPort)/") {
                DispatchQueue.main.async { [weak self] in self?.loadAppPage() }
            }
        }
    }

    private func loadAppPage() {
        guard !didLoadApp, let url = URL(string: "http://127.0.0.1:\(appPort)/") else { return }
        didLoadApp = true
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    private func showStartupError(_ message: String) {
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        webView.loadHTMLString("""
        <!doctype html><meta charset="utf-8"><style>
        body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f4ed;color:#64748b;font:14px -apple-system,BlinkMacSystemFont,sans-serif}
        div{max-width:520px;padding:32px;text-align:center}strong{display:block;margin-bottom:10px;color:#b42336;font-size:18px}p{line-height:1.6}
        </style><div><strong>Schedule Wallpaper를 열지 못했습니다</strong><p>\(escaped)</p></div>
        """, baseURL: nil)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "wallpaper" {
            handleWallpaperMessage(message)
            return
        }
        guard message.name == "savePNG",
              let payload = message.body as? [String: Any],
              let name = payload["name"] as? String else { return }

        let data: Data
        do {
            data = try pngData(from: payload)
        } catch {
            let alert = NSAlert(error: error)
            alert.beginSheetModal(for: window)
            return
        }

        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png]
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = name
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let destination = panel.url else { return }
            do {
                try data.write(to: destination, options: .atomic)
            } catch {
                let alert = NSAlert(error: error)
                alert.beginSheetModal(for: self.window)
            }
        }
    }

    private func pngData(from payload: [String: Any]) throws -> Data {
        guard let dataURL = payload["data"] as? String,
              dataURL.hasPrefix("data:image/png;base64,"),
              let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
              !data.isEmpty,
              data.count <= 25 * 1024 * 1024,
              NSImage(data: data) != nil else {
            throw WallpaperBridgeError.invalidImage
        }
        return data
    }

    private func handleWallpaperMessage(_ message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any], let action = payload["action"] as? String else {
            notifyWallpaperResult(action: "unknown", ok: false, message: WallpaperBridgeError.invalidPayload.localizedDescription)
            return
        }
        do {
            let allScreens = NSScreen.screens
            guard !allScreens.isEmpty else { throw WallpaperBridgeError.noScreens }
            if action == "list" {
                notifyWallpaperResult(action: action, ok: true, message: "", screens: screenPayload(from: allScreens))
                return
            }
            let targetScreens = try selectedScreens(from: payload, allScreens: allScreens)
            let result: WallpaperOperationResult
            switch action {
            case "apply":
                result = try applyCurrentWallpaper(data: pngData(from: payload), targetScreens: targetScreens, allScreens: allScreens)
            case "restore":
                result = try restoreOriginalWallpaper(targetScreens: targetScreens, allScreens: allScreens)
            default:
                throw WallpaperBridgeError.invalidPayload
            }
            verifyWallpaperResult(action: action, result: result)
        } catch {
            notifyWallpaperResult(action: action, ok: false, message: error.localizedDescription)
        }
    }

    private func screenPayload(from screens: [NSScreen]) -> [[String: Any]] {
        screens.map { screen in
            let pixelWidth = Int((screen.frame.width * screen.backingScaleFactor).rounded())
            let pixelHeight = Int((screen.frame.height * screen.backingScaleFactor).rounded())
            return [
                "id": displayIdentifier(for: screen),
                "name": screen.localizedName,
                "resolution": "\(pixelWidth) × \(pixelHeight)",
                "isCurrent": screen == window.screen
            ]
        }
    }

    private func selectedScreens(from payload: [String: Any], allScreens: [NSScreen]) throws -> [NSScreen] {
        guard let rawIDs = payload["screenIDs"] as? [Any], !rawIDs.isEmpty else {
            throw WallpaperBridgeError.noScreensSelected
        }
        let ids = rawIDs.compactMap { $0 as? String }
        guard ids.count == rawIDs.count else { throw WallpaperBridgeError.invalidPayload }
        let requested = Set(ids)
        let screens = allScreens.filter { requested.contains(displayIdentifier(for: $0)) }
        guard screens.count == requested.count else { throw WallpaperBridgeError.selectedScreenUnavailable }
        return screens
    }

    private func applyCurrentWallpaper(data: Data, targetScreens: [NSScreen], allScreens: [NSScreen]) throws -> WallpaperOperationResult {
        try saveOriginalWallpaperSnapshotIfNeeded(screens: allScreens)

        let destination = try applicationSupportDirectory().appendingPathComponent("current-wallpaper.png")
        try data.write(to: destination, options: .atomic)

        let workspace = NSWorkspace.shared
        for screen in targetScreens {
            var options = workspace.desktopImageOptions(for: screen) ?? [:]
            options[.imageScaling] = NSImageScaling.scaleProportionallyUpOrDown.rawValue
            options[.allowClipping] = true
            try workspace.setDesktopImageURL(destination, for: screen, options: options)
        }
        return WallpaperOperationResult(
            message: "현재 미리보기를 배경화면으로 적용했습니다. (\(targetScreens.count)개 화면)",
            expectedURLs: targetScreens.map { ($0, destination.standardizedFileURL) }
        )
    }

    private func saveOriginalWallpaperSnapshotIfNeeded(screens: [NSScreen]) throws {
        let snapshotURL = try applicationSupportDirectory().appendingPathComponent("original-wallpapers.json")
        if FileManager.default.fileExists(atPath: snapshotURL.path) {
            _ = try readOriginalWallpaperSnapshot(from: snapshotURL)
            return
        }

        let workspace = NSWorkspace.shared
        let originals = try screens.map { screen -> OriginalScreenWallpaper in
            guard let url = workspace.desktopImageURL(for: screen) else {
                throw WallpaperBridgeError.originalUnavailable(screen.localizedName)
            }
            let options = workspace.desktopImageOptions(for: screen) ?? [:]
            return OriginalScreenWallpaper(
                displayID: displayIdentifier(for: screen),
                displayName: screen.localizedName,
                url: url.absoluteString,
                imageScaling: (options[.imageScaling] as? NSNumber)?.intValue,
                allowClipping: (options[.allowClipping] as? NSNumber)?.boolValue
            )
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(OriginalWallpaperSnapshot(capturedAt: Date(), screens: originals)).write(to: snapshotURL, options: .atomic)
    }

    private func restoreOriginalWallpaper(targetScreens: [NSScreen], allScreens: [NSScreen]) throws -> WallpaperOperationResult {
        let snapshotURL = try applicationSupportDirectory().appendingPathComponent("original-wallpapers.json")
        guard FileManager.default.fileExists(atPath: snapshotURL.path) else { throw WallpaperBridgeError.originalNotSaved }
        let snapshot = try readOriginalWallpaperSnapshot(from: snapshotURL)

        let workspace = NSWorkspace.shared
        var restoredURLs: [(NSScreen, URL)] = []
        for screen in targetScreens {
            let index = allScreens.firstIndex(of: screen)
            let original = snapshot.screens.first(where: { $0.displayID == displayIdentifier(for: screen) })
                ?? snapshot.screens.first(where: { $0.displayName == screen.localizedName })
                ?? (snapshot.screens.count == allScreens.count ? index.map { snapshot.screens[$0] } : nil)
            guard let original,
                  let url = URL(string: original.url),
                  url.isFileURL,
                  FileManager.default.fileExists(atPath: url.path) else {
                throw WallpaperBridgeError.originalUnavailable(screen.localizedName)
            }
            var options = workspace.desktopImageOptions(for: screen) ?? [:]
            if let scaling = original.imageScaling { options[.imageScaling] = scaling }
            if let clipping = original.allowClipping { options[.allowClipping] = clipping }
            try workspace.setDesktopImageURL(url, for: screen, options: options)
            restoredURLs.append((screen, url.standardizedFileURL))
        }
        return WallpaperOperationResult(
            message: "원래 배경화면으로 복원했습니다. (\(targetScreens.count)개 화면)",
            expectedURLs: restoredURLs.map { ($0.0, $0.1) }
        )
    }

    private func readOriginalWallpaperSnapshot(from url: URL) throws -> OriginalWallpaperSnapshot {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let snapshot = try decoder.decode(OriginalWallpaperSnapshot.self, from: Data(contentsOf: url))
        guard !snapshot.screens.isEmpty else { throw WallpaperBridgeError.originalNotSaved }
        return snapshot
    }

    private func displayIdentifier(for screen: NSScreen) -> String {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        return (screen.deviceDescription[key] as? NSNumber)?.stringValue ?? screen.localizedName
    }

    private func verifyWallpaperResult(action: String, result: WallpaperOperationResult, attempt: Int = 0) {
        let workspace = NSWorkspace.shared
        let verified = result.expectedURLs.allSatisfy {
            workspace.desktopImageURL(for: $0.screen)?.standardizedFileURL == $0.url
        }
        if verified {
            notifyWallpaperResult(action: action, ok: true, message: result.message)
            return
        }
        guard attempt < 10 else {
            notifyWallpaperResult(action: action, ok: false, message: WallpaperBridgeError.verificationFailed.localizedDescription)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            self?.verifyWallpaperResult(action: action, result: result, attempt: attempt + 1)
        }
    }

    private func notifyWallpaperResult(action: String, ok: Bool, message: String, screens: [[String: Any]]? = nil) {
        var payload: [String: Any] = ["action": action, "ok": ok, "message": message]
        if let screens { payload["screens"] = screens }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('schedule-wallpaper:native-result',{detail:\(json)}));")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.image]
        panel.prompt = "선택"

        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()

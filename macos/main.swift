import Cocoa
import WebKit
import UniformTypeIdentifiers

private let appPort = 18767

private enum WallpaperBridgeError: LocalizedError {
    case invalidPayload
    case invalidImage
    case noScreens
    case originalNotSaved
    case originalUnavailable(String)
    case verificationFailed

    var errorDescription: String? {
        switch self {
        case .invalidPayload: return "앱에서 올바른 배경화면 요청을 받지 못했습니다."
        case .invalidImage: return "현재 미리보기를 PNG 이미지로 만들지 못했습니다."
        case .noScreens: return "연결된 디스플레이를 찾지 못했습니다."
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
        true
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
        NSApp.mainMenu = mainMenu
    }

    private func configureAppIcon() {
        let size = NSSize(width: 256, height: 256)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor(calibratedRed: 0.93, green: 0.96, blue: 1.0, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: 54, yRadius: 54).fill()
        NSColor(calibratedRed: 0.15, green: 0.39, blue: 0.92, alpha: 1).setFill()
        for (x, height) in [(70.0, 62.0), (116.0, 122.0), (162.0, 88.0)] {
            NSBezierPath(roundedRect: NSRect(x: x, y: 58, width: 24, height: height), xRadius: 12, yRadius: 12).fill()
        }
        image.unlockFocus()
        NSApp.applicationIconImage = image
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
            let message: String
            switch action {
            case "apply":
                message = try applyCurrentWallpaper(data: pngData(from: payload))
            case "restore":
                message = try restoreOriginalWallpaper()
            default:
                throw WallpaperBridgeError.invalidPayload
            }
            notifyWallpaperResult(action: action, ok: true, message: message)
        } catch {
            notifyWallpaperResult(action: action, ok: false, message: error.localizedDescription)
        }
    }

    private func applyCurrentWallpaper(data: Data) throws -> String {
        let screens = NSScreen.screens
        guard !screens.isEmpty else { throw WallpaperBridgeError.noScreens }
        try saveOriginalWallpaperSnapshotIfNeeded(screens: screens)

        let destination = try applicationSupportDirectory().appendingPathComponent("current-wallpaper.png")
        try data.write(to: destination, options: .atomic)

        let workspace = NSWorkspace.shared
        for screen in screens {
            var options = workspace.desktopImageOptions(for: screen) ?? [:]
            options[.imageScaling] = NSImageScaling.scaleProportionallyUpOrDown.rawValue
            options[.allowClipping] = true
            try workspace.setDesktopImageURL(destination, for: screen, options: options)
        }
        guard screens.allSatisfy({ workspace.desktopImageURL(for: $0)?.standardizedFileURL == destination.standardizedFileURL }) else {
            throw WallpaperBridgeError.verificationFailed
        }
        return "현재 미리보기를 배경화면으로 적용했습니다. (\(screens.count)개 화면)"
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

    private func restoreOriginalWallpaper() throws -> String {
        let snapshotURL = try applicationSupportDirectory().appendingPathComponent("original-wallpapers.json")
        guard FileManager.default.fileExists(atPath: snapshotURL.path) else { throw WallpaperBridgeError.originalNotSaved }
        let snapshot = try readOriginalWallpaperSnapshot(from: snapshotURL)
        let screens = NSScreen.screens
        guard !screens.isEmpty else { throw WallpaperBridgeError.noScreens }

        let workspace = NSWorkspace.shared
        var restoredURLs: [(NSScreen, URL)] = []
        for (index, screen) in screens.enumerated() {
            let original = snapshot.screens.first(where: { $0.displayID == displayIdentifier(for: screen) })
                ?? snapshot.screens.first(where: { $0.displayName == screen.localizedName })
                ?? (snapshot.screens.count == screens.count ? snapshot.screens[index] : nil)
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
        guard restoredURLs.allSatisfy({ workspace.desktopImageURL(for: $0.0)?.standardizedFileURL == $0.1 }) else {
            throw WallpaperBridgeError.verificationFailed
        }
        return "원래 배경화면으로 복원했습니다. (\(screens.count)개 화면)"
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

    private func notifyWallpaperResult(action: String, ok: Bool, message: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["action": action, "ok": ok, "message": message]),
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

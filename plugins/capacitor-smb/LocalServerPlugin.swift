import Foundation
import Capacitor
import Network

struct LSError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

/// JS name: "LocalServer" (Capacitor.Plugins.LocalServer)
///
/// A tiny HTTP server bound to 127.0.0.1 (loopback only, never reachable from the network) that serves
/// imported web apps (zips / folders / WebAssembly) from disk, so they run on a real http:// origin:
/// relative paths, ES modules, Web Workers and WebAssembly streaming all work.
///
/// Flow used by the launcher:
///   start()                       -> { port }
///   getVersion({ id })            -> { version }      (lets the launcher skip re-copying unchanged apps)
///   clearApp({ id })
///   writeFile({ id, path, data, append })   (data = base64 chunk; first chunk append=false)
///   finish({ id, version })
///   then load  http://127.0.0.1:<port>/<id>/<entry>  in the iframe.
@objc(LocalServerPlugin)
public class LocalServerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocalServerPlugin"
    public let jsName = "LocalServer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getVersion", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearApp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise)
    ]

    private let stateLock = NSLock()
    private var listener: NWListener?
    private var port: UInt16 = 0
    private let serverQueue = DispatchQueue(label: "localserver.net", qos: .userInitiated)
    private let ioQueue = DispatchQueue(label: "localserver.io", qos: .userInitiated, attributes: .concurrent)
    private let versionFile = ".wl_version"

    /// Caches/WebLauncherVFS  (iOS may purge Caches; the launcher just re-copies the app when the version marker is gone)
    private var root: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return caches.appendingPathComponent("WebLauncherVFS", isDirectory: true)
    }

    // Small script injected into every served HTML page: forwards errors to the launcher's crash log.
    // (The page is cross-origin to the launcher, so window.parent can only be reached through postMessage.)
    private let injectedScript = #"""
    <script>(function(){try{var P=window.parent;if(!P||P===window)return;
    function s(l,m){try{P.postMessage({__weblauncher:1,level:l,msg:String(m)},'*')}catch(e){}}
    var oe=console.error;console.error=function(){s('APP_ERR',Array.prototype.map.call(arguments,String).join(' '));return oe.apply(console,arguments)};
    window.addEventListener('error',function(e){s('APP_FATAL',(e.message||'')+' @ '+(e.lineno||0))});
    window.addEventListener('unhandledrejection',function(e){s('APP_REJECT',(e.reason&&e.reason.message)||e.reason)});
    }catch(e){}})();</script>
    """#

    // MARK: - Plugin API

    @objc func start(_ call: CAPPluginCall) {
        stateLock.lock()
        if let l = listener, port != 0, case .ready = l.state {
            let p = port
            stateLock.unlock()
            call.resolve(["port": Int(p)])
            return
        }
        let stale = listener
        listener = nil
        port = 0
        stateLock.unlock()
        stale?.cancel()

        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
            let l = try NWListener(using: params)
            var answered = false

            l.stateUpdateHandler = { [weak self, weak l] state in
                guard let self = self else { return }
                switch state {
                case .ready:
                    let p = l?.port?.rawValue ?? 0
                    self.stateLock.lock()
                    self.listener = l
                    self.port = p
                    self.stateLock.unlock()
                    if !answered {
                        answered = true
                        if p == 0 { call.reject("Local server did not get a port") }
                        else { call.resolve(["port": Int(p)]) }
                    }
                case .failed(let err):
                    self.stateLock.lock()
                    if self.listener === l { self.listener = nil; self.port = 0 }
                    self.stateLock.unlock()
                    l?.cancel()
                    if !answered {
                        answered = true
                        call.reject("Local server failed: \(err.localizedDescription)")
                    }
                case .cancelled:
                    self.stateLock.lock()
                    if self.listener === l { self.listener = nil; self.port = 0 }
                    self.stateLock.unlock()
                default:
                    break
                }
            }
            l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
            l.start(queue: serverQueue)
        } catch {
            call.reject("Could not start local server: \(error.localizedDescription)")
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        stateLock.lock()
        let l = listener
        listener = nil
        port = 0
        stateLock.unlock()
        l?.cancel()
        call.resolve()
    }

    @objc func getVersion(_ call: CAPPluginCall) {
        do {
            let id = try safeId(call.getString("id"))
            let url = root.appendingPathComponent(id, isDirectory: true).appendingPathComponent(versionFile)
            let v = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
            call.resolve(["version": v])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func clearApp(_ call: CAPPluginCall) {
        ioQueue.async {
            do {
                let id = try self.safeId(call.getString("id"))
                let dir = self.root.appendingPathComponent(id, isDirectory: true)
                if FileManager.default.fileExists(atPath: dir.path) {
                    try FileManager.default.removeItem(at: dir)
                }
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func writeFile(_ call: CAPPluginCall) {
        ioQueue.async {
            do {
                let id = try self.safeId(call.getString("id"))
                let path = call.getString("path") ?? ""
                guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
                    throw LSError("Invalid file data")
                }
                let append = call.getBool("append") ?? false
                let url = try self.fileURL(id: id, path: path)
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)

                if append, FileManager.default.fileExists(atPath: url.path) {
                    let fh = try FileHandle(forWritingTo: url)
                    defer { try? fh.close() }
                    try fh.seekToEnd()
                    try fh.write(contentsOf: data)
                } else {
                    try data.write(to: url, options: .atomic)
                }
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        ioQueue.async {
            do {
                let id = try self.safeId(call.getString("id"))
                let version = call.getString("version") ?? ""
                let dir = self.root.appendingPathComponent(id, isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try version.write(to: dir.appendingPathComponent(self.versionFile), atomically: true, encoding: .utf8)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    // MARK: - Paths

    private func isValidId(_ id: String) -> Bool {
        if id.isEmpty || id.count > 80 { return false }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        return id.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    private func safeId(_ id: String?) throws -> String {
        guard let id = id, isValidId(id) else { throw LSError("Invalid app id") }
        return id
    }

    /// <root>/<id>/<path>, refusing "." and ".." segments.
    private func fileURL(id: String, path: String) throws -> URL {
        var url = root.appendingPathComponent(id, isDirectory: true)
        var added = 0
        for part in path.split(separator: "/", omittingEmptySubsequences: true) {
            let s = String(part)
            if s == "." { continue }
            if s == ".." { throw LSError("Invalid path") }
            url.appendPathComponent(s)
            added += 1
        }
        if added == 0 { throw LSError("Empty file path") }
        return url
    }

    // MARK: - HTTP server

    private func accept(_ conn: NWConnection) {
        conn.stateUpdateHandler = { [weak conn] state in
            if case .failed = state { conn?.cancel() }
        }
        conn.start(queue: serverQueue)
        receiveRequest(conn, buffer: Data())
    }

    private func receiveRequest(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else { conn.cancel(); return }
            var buf = buffer
            if let d = data { buf.append(d) }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = buf[buf.startIndex..<end.lowerBound]
                self.ioQueue.async { self.handleRequest(conn, head: Data(head)) }
            } else if error != nil || isComplete || buf.count > 65536 {
                conn.cancel()
            } else {
                self.receiveRequest(conn, buffer: buf)
            }
        }
    }

    private func handleRequest(_ conn: NWConnection, head: Data) {
        let text = String(decoding: head, as: UTF8.self)
        let lines = text.components(separatedBy: "\r\n")
        guard let first = lines.first else { return sendError(conn, 400, "Bad Request") }
        let parts = first.split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count >= 2 else { return sendError(conn, 400, "Bad Request") }

        let method = String(parts[0]).uppercased()
        guard method == "GET" || method == "HEAD" else { return sendError(conn, 405, "Method Not Allowed") }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let idx = line.firstIndex(of: ":") else { continue }
            let k = line[line.startIndex..<idx].lowercased()
            let v = line[line.index(after: idx)...].trimmingCharacters(in: .whitespaces)
            headers[k] = v
        }

        var target = String(parts[1])
        if let q = target.firstIndex(where: { $0 == "?" || $0 == "#" }) {
            target = String(target[target.startIndex..<q])
        }
        guard let decoded = target.removingPercentEncoding else { return sendError(conn, 400, "Bad Request") }

        let comps = decoded.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard let id = comps.first, isValidId(id) else { return sendError(conn, 404, "Not Found") }
        let rel = Array(comps.dropFirst())
        if rel.contains("..") || rel.contains(".") { return sendError(conn, 400, "Bad Request") }

        let fm = FileManager.default
        let appDir = root.appendingPathComponent(id, isDirectory: true)
        var file = appDir
        for r in rel { file.appendPathComponent(r) }

        var isDir: ObjCBool = false
        let exists = fm.fileExists(atPath: file.path, isDirectory: &isDir)
        if rel.isEmpty || decoded.hasSuffix("/") || (exists && isDir.boolValue) {
            file.appendPathComponent("index.html")
        } else if !exists, !(rel.last ?? "").contains(".") {
            // Single-page-app style fallback for extension-less navigations
            file = appDir.appendingPathComponent("index.html")
        }

        var isDir2: ObjCBool = false
        guard fm.fileExists(atPath: file.path, isDirectory: &isDir2), !isDir2.boolValue else {
            return sendError(conn, 404, "Not Found")
        }

        serve(conn, file: file, head: method == "HEAD", rangeHeader: headers["range"])
    }

    private func serve(_ conn: NWConnection, file: URL, head: Bool, rangeHeader: String?) {
        let ext = file.pathExtension.lowercased()
        let mime = LocalServerPlugin.mimeTypes[ext] ?? "application/octet-stream"

        // HTML: load fully and inject the log-forwarding script
        if ext == "html" || ext == "htm" {
            guard let raw = try? Data(contentsOf: file) else { return sendError(conn, 500, "Read error") }
            var html = String(decoding: raw, as: UTF8.self)
            if let r = html.range(of: "<head[^>]*>", options: [.regularExpression, .caseInsensitive]) {
                html.insert(contentsOf: injectedScript, at: r.upperBound)
            } else {
                html = injectedScript + html
            }
            let body = Data(html.utf8)
            let h = headerData(200, "OK", [("Content-Type", mime), ("Content-Length", String(body.count)), ("Cache-Control", "no-store")])
            conn.send(content: h + (head ? Data() : body), completion: .contentProcessed({ [weak self] _ in self?.finish(conn) }))
            return
        }

        guard let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
              let size = (attrs[.size] as? NSNumber)?.int64Value else {
            return sendError(conn, 500, "Read error")
        }

        var start: Int64 = 0
        var end: Int64 = size - 1
        var status = 200
        var fields: [(String, String)] = [("Content-Type", mime), ("Accept-Ranges", "bytes"), ("Cache-Control", "no-store")]

        if let rh = rangeHeader, let r = parseRange(rh, size: size) {
            start = r.0
            end = r.1
            status = 206
            fields.append(("Content-Range", "bytes \(start)-\(end)/\(size)"))
        }
        let length = size == 0 ? 0 : (end - start + 1)
        fields.append(("Content-Length", String(length)))

        let h = headerData(status, status == 206 ? "Partial Content" : "OK", fields)
        if head || length == 0 {
            conn.send(content: h, completion: .contentProcessed({ [weak self] _ in self?.finish(conn) }))
            return
        }

        guard let fh = try? FileHandle(forReadingFrom: file) else { return sendError(conn, 500, "Read error") }
        do { try fh.seek(toOffset: UInt64(start)) } catch { try? fh.close(); return sendError(conn, 500, "Read error") }

        conn.send(content: h, completion: .contentProcessed({ [weak self] err in
            if err != nil { try? fh.close(); conn.cancel(); return }
            self?.ioQueue.async { self?.stream(conn, handle: fh, remaining: length) }
        }))
    }

    private func stream(_ conn: NWConnection, handle: FileHandle, remaining: Int64) {
        if remaining <= 0 {
            try? handle.close()
            finish(conn)
            return
        }
        let n = Int(min(remaining, 262_144))
        let chunk: Data
        do {
            chunk = try handle.read(upToCount: n) ?? Data()
        } catch {
            try? handle.close()
            conn.cancel()
            return
        }
        if chunk.isEmpty {
            try? handle.close()
            finish(conn)
            return
        }
        conn.send(content: chunk, completion: .contentProcessed({ [weak self] err in
            if err != nil { try? handle.close(); conn.cancel(); return }
            self?.ioQueue.async { self?.stream(conn, handle: handle, remaining: remaining - Int64(chunk.count)) }
        }))
    }

    private func finish(_ conn: NWConnection) {
        conn.send(content: nil, contentContext: .finalMessage, isComplete: true,
                  completion: .contentProcessed({ _ in conn.cancel() }))
    }

    private func sendError(_ conn: NWConnection, _ status: Int, _ reason: String) {
        let body = Data("\(status) \(reason)".utf8)
        let h = headerData(status, reason, [("Content-Type", "text/plain; charset=utf-8"), ("Content-Length", String(body.count))])
        conn.send(content: h + body, completion: .contentProcessed({ [weak self] _ in self?.finish(conn) }))
    }

    private func headerData(_ status: Int, _ reason: String, _ fields: [(String, String)]) -> Data {
        var s = "HTTP/1.1 \(status) \(reason)\r\n"
        for (k, v) in fields { s += "\(k): \(v)\r\n" }
        s += "Connection: close\r\n\r\n"
        return Data(s.utf8)
    }

    /// "bytes=START-END", "bytes=START-" or "bytes=-SUFFIX". Returns nil if absent / unsatisfiable (-> full response).
    private func parseRange(_ header: String, size: Int64) -> (Int64, Int64)? {
        guard size > 0, header.lowercased().hasPrefix("bytes=") else { return nil }
        let spec = header.dropFirst(6).split(separator: ",").first.map(String.init) ?? ""
        let p = spec.split(separator: "-", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespaces) }
        guard p.count == 2 else { return nil }

        let start: Int64
        var end: Int64
        if p[0].isEmpty {
            guard let n = Int64(p[1]), n > 0 else { return nil }
            start = max(0, size - n)
            end = size - 1
        } else {
            guard let s = Int64(p[0]) else { return nil }
            start = s
            end = p[1].isEmpty ? size - 1 : (Int64(p[1]) ?? size - 1)
        }
        end = min(end, size - 1)
        guard start <= end, start < size else { return nil }
        return (start, end)
    }

    private static let mimeTypes: [String: String] = [
        "html": "text/html; charset=utf-8", "htm": "text/html; charset=utf-8",
        "css": "text/css; charset=utf-8", "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8", "json": "application/json; charset=utf-8",
        "map": "application/json; charset=utf-8", "wasm": "application/wasm",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "webp": "image/webp", "ico": "image/x-icon", "avif": "image/avif",
        "wav": "audio/wav", "mp3": "audio/mpeg", "ogg": "audio/ogg", "m4a": "audio/mp4",
        "mp4": "video/mp4", "webm": "video/webm", "txt": "text/plain; charset=utf-8",
        "md": "text/markdown; charset=utf-8", "xml": "application/xml",
        "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf",
        "webmanifest": "application/manifest+json", "data": "application/octet-stream", "bin": "application/octet-stream"
    ]
}

import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

struct DFError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

/// JS name: "DeviceFiles" (Capacitor.Plugins.DeviceFiles)
/// Lets the user pick folders from the iOS Files app (On My iPhone, iCloud Drive, USB drives,
/// third-party providers) and keeps a persistent, security-scoped bookmark for each one.
/// Every file call takes { root: <id returned by pickFolder>, path: "relative/path" ("" = root) }.
@objc(DeviceFilesPlugin)
public class DeviceFilesPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "DeviceFilesPlugin"
    public let jsName = "DeviceFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listRoots", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeRoot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeBegin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeEnd", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeAbort", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "move", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copy", returnType: CAPPluginReturnPromise)
    ]

    private let lock = NSLock()
    private let defaultsKey = "OpenFiles.DeviceFiles.roots"
    private var accessed: [String: URL] = [:]
    private var uploads: [String: URL] = [:]
    private var pendingPick: CAPPluginCall?
    private let work = DispatchQueue(label: "devicefiles.work", qos: .userInitiated, attributes: .concurrent)

    // MARK: - Stored roots

    private func loadRoots() -> [String: [String: Any]] {
        return (UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: [String: Any]]) ?? [:]
    }

    private func saveRoots(_ roots: [String: [String: Any]]) {
        UserDefaults.standard.set(roots, forKey: defaultsKey)
    }

    private func rootURL(_ id: String) throws -> URL {
        lock.lock(); defer { lock.unlock() }
        if let u = accessed[id] { return u }
        var roots = loadRoots()
        guard let entry = roots[id], let data = entry["bookmark"] as? Data else {
            throw DFError("Folder not found. Remove this location and add the folder again.")
        }
        var stale = false
        let url: URL
        do {
            url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        } catch {
            throw DFError("Access to this folder was lost (it may have been moved or deleted). Remove this location and add the folder again.")
        }
        _ = url.startAccessingSecurityScopedResource()
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            var e = entry
            e["bookmark"] = fresh
            roots[id] = e
            saveRoots(roots)
        }
        accessed[id] = url
        return url
    }

    /// root + relative path -> URL, refusing "..".
    private func resolve(_ call: CAPPluginCall, pathKey: String = "path", rootKey: String = "root") throws -> URL {
        guard let id = call.getString(rootKey) else { throw DFError("Missing root") }
        return try resolve(id: id, path: call.getString(pathKey) ?? "")
    }

    private func resolve(id: String, path: String) throws -> URL {
        var url = try rootURL(id)
        for part in path.split(separator: "/") {
            let s = String(part)
            if s.isEmpty || s == "." { continue }
            if s == ".." { throw DFError("Invalid path") }
            url.appendPathComponent(s)
        }
        return url
    }

    private func entry(_ url: URL, name: String? = nil) -> [String: Any] {
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
        let v = try? url.resourceValues(forKeys: keys)
        var out: [String: Any] = [
            "name": name ?? url.lastPathComponent,
            "isDir": v?.isDirectory ?? false,
            "size": v?.fileSize ?? 0
        ]
        if let d = v?.contentModificationDate { out["modified"] = d.timeIntervalSince1970 * 1000 }
        return out
    }

    private func run(_ call: CAPPluginCall, _ body: @escaping () throws -> [String: Any]?) {
        work.async {
            do {
                if let r = try body() { call.resolve(r) } else { call.resolve() }
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    // MARK: - Coordination (needed so iCloud / provider files download and sync properly)

    private func coordRead<T>(_ url: URL, _ body: (URL) throws -> T) throws -> T {
        var coordErr: NSError?
        var result: Result<T, Error>?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordErr) { u in
            result = Result { try body(u) }
        }
        if let e = coordErr { throw e }
        guard let r = result else { throw DFError("Could not access the file") }
        return try r.get()
    }

    private func coordWrite<T>(_ url: URL, options: NSFileCoordinator.WritingOptions, _ body: (URL) throws -> T) throws -> T {
        var coordErr: NSError?
        var result: Result<T, Error>?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: options, error: &coordErr) { u in
            result = Result { try body(u) }
        }
        if let e = coordErr { throw e }
        guard let r = result else { throw DFError("Could not write to the location") }
        return try r.get()
    }

    // MARK: - Picking folders

    @objc func pickFolder(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { call.reject("No view controller available"); return }
            if let old = self.pendingPick { old.reject("cancelled"); self.bridge?.releaseCall(old) }
            self.bridge?.saveCall(call)
            self.pendingPick = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            vc.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingPick else { return }
        pendingPick = nil
        defer { bridge?.releaseCall(call) }
        guard let url = urls.first else { call.reject("cancelled"); return }
        guard url.startAccessingSecurityScopedResource() else {
            call.reject("iOS did not grant access to that folder")
            return
        }
        do {
            let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            let id = UUID().uuidString
            var roots = loadRoots()
            roots[id] = ["name": url.lastPathComponent, "bookmark": data]
            saveRoots(roots)
            lock.lock(); accessed[id] = url; lock.unlock()
            call.resolve(["root": id, "name": url.lastPathComponent])
        } catch {
            url.stopAccessingSecurityScopedResource()
            call.reject(error.localizedDescription)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let call = pendingPick else { return }
        pendingPick = nil
        call.reject("cancelled")
        bridge?.releaseCall(call)
    }

    @objc func listRoots(_ call: CAPPluginCall) {
        let roots = loadRoots().map { ["root": $0.key, "name": ($0.value["name"] as? String) ?? ""] }
        call.resolve(["roots": roots])
    }

    @objc func removeRoot(_ call: CAPPluginCall) {
        guard let id = call.getString("root") else { call.resolve(); return }
        lock.lock()
        if let u = accessed.removeValue(forKey: id) { u.stopAccessingSecurityScopedResource() }
        lock.unlock()
        var roots = loadRoots()
        roots.removeValue(forKey: id)
        saveRoots(roots)
        call.resolve()
    }

    // MARK: - Browsing

    @objc func list(_ call: CAPPluginCall) {
        run(call) {
            let url = try self.resolve(call)
            let kids = try self.coordRead(url) { u in
                try FileManager.default.contentsOfDirectory(
                    at: u,
                    includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey],
                    options: [] // keep hidden files; the web UI has its own hidden-files toggle
                )
            }
            return ["entries": kids.map { self.entry($0) }]
        }
    }

    @objc func stat(_ call: CAPPluginCall) {
        run(call) {
            let url = try self.resolve(call)
            guard FileManager.default.fileExists(atPath: url.path) else { throw DFError("Not found") }
            return self.entry(url)
        }
    }

    // MARK: - Reading

    @objc func read(_ call: CAPPluginCall) {
        let offset = UInt64(max(0, call.getInt("offset") ?? 0))
        let length = max(0, call.getInt("length") ?? 0)
        run(call) {
            let url = try self.resolve(call)
            let data: Data = try self.coordRead(url) { u in
                let h = try FileHandle(forReadingFrom: u)
                defer { try? h.close() }
                try h.seek(toOffset: offset)
                if length > 0 { return try h.read(upToCount: length) ?? Data() }
                return try h.readToEnd() ?? Data()
            }
            return ["data": data.base64EncodedString()]
        }
    }

    // MARK: - Writing (chunked upload to a temp file, then moved into place)

    @objc func writeBegin(_ call: CAPPluginCall) {
        let token = UUID().uuidString
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("df-upload-" + token)
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            call.reject("Could not create temp file"); return
        }
        lock.lock(); uploads[token] = url; lock.unlock()
        call.resolve(["token": token])
    }

    @objc func writeChunk(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), let b64 = call.getString("data") else {
            call.reject("Missing token or data"); return
        }
        lock.lock(); let url = uploads[token]; lock.unlock()
        guard let url = url else { call.reject("Unknown upload"); return }
        guard let data = Data(base64Encoded: b64) else { call.reject("Bad data"); return }
        do {
            let h = try FileHandle(forWritingTo: url)
            defer { try? h.close() }
            try h.seekToEnd()
            try h.write(contentsOf: data)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func writeEnd(_ call: CAPPluginCall) {
        guard let token = call.getString("token") else { call.reject("Missing token"); return }
        lock.lock(); let tmp = uploads.removeValue(forKey: token); lock.unlock()
        guard let tmp = tmp else { call.reject("Unknown upload"); return }
        run(call) {
            defer { try? FileManager.default.removeItem(at: tmp) }
            let dest = try self.resolve(call)
            let fm = FileManager.default
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: dest.path, isDirectory: &isDir), isDir.boolValue {
                throw DFError("A folder with that name already exists")
            }
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            try self.coordWrite(dest, options: .forReplacing) { u in
                if fm.fileExists(atPath: u.path) { try fm.removeItem(at: u) }
                try fm.copyItem(at: tmp, to: u)
            }
            return nil
        }
    }

    @objc func writeAbort(_ call: CAPPluginCall) {
        if let token = call.getString("token") {
            lock.lock(); let url = uploads.removeValue(forKey: token); lock.unlock()
            if let url = url { try? FileManager.default.removeItem(at: url) }
        }
        call.resolve()
    }

    // MARK: - Structure changes

    @objc func mkdir(_ call: CAPPluginCall) {
        run(call) {
            let url = try self.resolve(call)
            if FileManager.default.fileExists(atPath: url.path) { throw DFError("An item with that name already exists (exists)") }
            try self.coordWrite(url, options: []) { u in
                try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
            }
            return nil
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        run(call) {
            let url = try self.resolve(call)
            guard FileManager.default.fileExists(atPath: url.path) else { throw DFError("Not found") }
            try self.coordWrite(url, options: .forDeleting) { u in try FileManager.default.removeItem(at: u) }
            return nil
        }
    }

    @objc func move(_ call: CAPPluginCall) {
        run(call) {
            let src = try self.resolve(call, pathKey: "from")
            let dst = try self.resolve(call, pathKey: "to")
            let fm = FileManager.default
            if fm.fileExists(atPath: dst.path) { throw DFError("An item with that name already exists (exists)") }
            try fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
            var coordErr: NSError?
            var failure: Error?
            NSFileCoordinator(filePresenter: nil).coordinate(
                writingItemAt: src, options: .forMoving,
                writingItemAt: dst, options: .forReplacing,
                error: &coordErr
            ) { s, d in
                do { try fm.moveItem(at: s, to: d) } catch { failure = error }
            }
            if let e = coordErr { throw e }
            if let f = failure { throw f }
            return nil
        }
    }

    @objc func copy(_ call: CAPPluginCall) {
        run(call) {
            let src = try self.resolve(call, pathKey: "from")
            let dst = try self.resolve(call, pathKey: "to")
            let fm = FileManager.default
            if fm.fileExists(atPath: dst.path) { throw DFError("An item with that name already exists (exists)") }
            try fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
            try self.coordRead(src) { s in
                try self.coordWrite(dst, options: .forReplacing) { d in try fm.copyItem(at: s, to: d) }
            }
            return nil
        }
    }
}

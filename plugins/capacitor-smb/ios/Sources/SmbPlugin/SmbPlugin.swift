import Foundation
import Capacitor
import AMSMB2

/// JS name: "Smb" (Capacitor.Plugins.Smb)
/// All paths are relative to the share root, without a leading slash ("" = root).
@objc(SmbPlugin)
public class SmbPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SmbPlugin"
    public let jsName = "Smb"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeBegin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeEnd", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeAbort", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "move", returnType: CAPPluginReturnPromise)
    ]

    private let lock = NSLock()
    private var sessions: [String: SMB2Manager] = [:]
    private var uploads: [String: URL] = [:]

    // MARK: - Helpers

    private func session(_ call: CAPPluginCall) -> SMB2Manager? {
        guard let id = call.getString("id") else { call.reject("Missing id"); return nil }
        lock.lock(); defer { lock.unlock() }
        guard let m = sessions[id] else { call.reject("Not connected. Call connect first."); return nil }
        return m
    }

    private func storeSession(_ manager: SMB2Manager, for id: String) {
        lock.lock()
        sessions[id] = manager
        lock.unlock()
    }

    private func attrs(_ a: [URLResourceKey: Any], name: String? = nil) -> [String: Any] {
        let type = a[.fileResourceTypeKey] as? URLFileResourceType
        var out: [String: Any] = [
            "name": name ?? (a[.nameKey] as? String ?? ""),
            "isDir": type == .directory,
            "size": (a[.fileSizeKey] as? Int64) ?? 0
        ]
        if let d = a[.contentModificationDateKey] as? Date {
            out["modified"] = d.timeIntervalSince1970 * 1000
        }
        return out
    }

    private func removeRecursive(_ m: SMB2Manager, _ path: String, isDir: Bool) async throws {
        if isDir {
            let items = try await m.contentsOfDirectory(atPath: path)
            for it in items {
                guard let name = it[.nameKey] as? String, name != ".", name != ".." else { continue }
                let child = path.isEmpty ? name : path + "/" + name
                let childIsDir = (it[.fileResourceTypeKey] as? URLFileResourceType) == .directory
                try await removeRecursive(m, child, isDir: childIsDir)
            }
        }
        try await m.removeItem(atPath: path)
    }

    // MARK: - Connection

    @objc func connect(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let rawHost = call.getString("host"), !rawHost.isEmpty,
              let share = call.getString("share"), !share.isEmpty else {
            call.reject("Missing host or share"); return
        }

        var host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines)
        if host.lowercased().hasPrefix("smb://") {
            host = String(host.dropFirst(6))
        }
        if host.hasSuffix("/") {
            host = String(host.dropLast())
        }

        let user = call.getString("username") ?? "guest"
        let pass = call.getString("password") ?? ""
        let domain = call.getString("domain") ?? ""
        let port = call.getInt("port") ?? 0

        var comps = URLComponents()
        comps.scheme = "smb"
        comps.host = host
        if port > 0 && port != 445 { comps.port = port }
        guard let url = comps.url else { call.reject("Invalid server address"); return }

        let cred = URLCredential(user: user.isEmpty ? "guest" : user, password: pass, persistence: .forSession)
        guard let manager = SMB2Manager(url: url, domain: domain, credential: cred) else {
            call.reject("Could not create SMB client"); return
        }

        Task {
            do {
                try await manager.connectShare(name: share)
                self.storeSession(manager, for: id)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.resolve(); return }
        lock.lock()
        let m = sessions.removeValue(forKey: id)
        lock.unlock()
        guard let manager = m else { call.resolve(); return }
        Task {
            try? await manager.disconnectShare()
            call.resolve()
        }
    }

    // MARK: - Browsing

    @objc func list(_ call: CAPPluginCall) {
        guard let m = session(call) else { return }
        let path = call.getString("path") ?? ""
        Task {
            do {
                let items = try await m.contentsOfDirectory(atPath: path)
                let entries = items.compactMap { it -> [String: Any]? in
                    guard let name = it[.nameKey] as? String, name != ".", name != ".." else { return nil }
                    return self.attrs(it, name: name)
                }
                call.resolve(["entries": entries])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func stat(_ call: CAPPluginCall) {
        guard let m = session(call) else { return }
        let path = call.getString("path") ?? ""
        Task {
            do {
                let a = try await m.attributesOfItem(atPath: path)
                call.resolve(self.attrs(a))
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    // MARK: - Reading

    @objc func read(_ call: CAPPluginCall) {
        guard let m = session(call), let path = call.getString("path") else { return }
        let offset = Int64(call.getInt("offset") ?? 0)
        let length = Int64(call.getInt("length") ?? 0)

        Task {
            do {
                let data: Data
                if length > 0 {
                    data = try await m.contents(atPath: path, range: offset..<(offset + length))
                } else if offset == 0 {
                    data = try await m.contents(atPath: path)
                } else {
                    data = try await m.contents(atPath: path, range: offset..<(offset + max(length, 1)))
                }
                call.resolve(["data": data.base64EncodedString()])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    // MARK: - Writing

    @objc func writeBegin(_ call: CAPPluginCall) {
        let token = UUID().uuidString
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("smb-upload-" + token)
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            call.reject("Could not create temp file")
            return
        }
        lock.lock()
        uploads[token] = url
        lock.unlock()
        call.resolve(["token": token])
    }

    @objc func writeChunk(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), let b64 = call.getString("data") else {
            call.reject("Missing token or data")
            return
        }
        lock.lock()
        let url = uploads[token]
        lock.unlock()
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
        guard let m = session(call), let token = call.getString("token"), let path = call.getString("path") else { return }
        lock.lock()
        let url = uploads.removeValue(forKey: token)
        lock.unlock()
        guard let url = url else { call.reject("Unknown upload"); return }

        Task {
            defer { try? FileManager.default.removeItem(at: url) }
            do {
                try await m.uploadItem(at: url, toPath: path, progress: nil)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func writeAbort(_ call: CAPPluginCall) {
        if let token = call.getString("token") {
            lock.lock()
            let url = uploads.removeValue(forKey: token)
            lock.unlock()
            if let url = url {
                try? FileManager.default.removeItem(at: url)
            }
        }
        call.resolve()
    }

    // MARK: - File Operations

    @objc func mkdir(_ call: CAPPluginCall) {
        guard let m = session(call), let path = call.getString("path") else { return }
        Task {
            do {
                try await m.createDirectory(atPath: path)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let m = session(call), let path = call.getString("path") else { return }
        let isDir = call.getBool("isDir") ?? false
        Task {
            do {
                try await self.removeRecursive(m, path, isDir: isDir)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func move(_ call: CAPPluginCall) {
        guard let m = session(call), let from = call.getString("from"), let to = call.getString("to") else { return }
        Task {
            do {
                try await m.moveItem(atPath: from, toPath: to)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }
}
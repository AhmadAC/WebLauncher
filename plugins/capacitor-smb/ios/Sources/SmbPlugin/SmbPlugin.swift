import Foundation
import Network
import Capacitor
import AMSMB2

/// Bonjour service discovery for local SMB servers
final class SMBBonjourDiscovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    private let browser = NetServiceBrowser()
    private var pendingServices: [NetService] = []
    private var foundServers: [[String: Any]] = []
    private var completion: (([[String: Any]]) -> Void)?

    func discover(timeout: TimeInterval = 3.5, completion: @escaping ([[String: Any]]) -> Void) {
        self.completion = completion
        self.foundServers = []
        self.pendingServices = []

        browser.delegate = self
        browser.searchForServices(ofType: "_smb._tcp.", inDomain: "local.")

        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self = self else { return }
            self.stop()
        }
    }

    func stop() {
        browser.stop()
        for s in pendingServices {
            s.stop()
        }
        pendingServices.removeAll()
        let cb = completion
        completion = nil
        cb?(foundServers)
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        pendingServices.append(service)
        service.delegate = self
        service.resolve(withTimeout: 3.0)
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        var ip = ""
        if let addresses = sender.addresses {
            for addrData in addresses {
                addrData.withUnsafeBytes { rawPtr in
                    guard let sockaddr = rawPtr.bindMemory(to: sockaddr.self).baseAddress else { return }
                    if sockaddr.pointee.sa_family == UInt8(AF_INET) {
                        var sin = rawPtr.bindMemory(to: sockaddr_in.self).baseAddress!.pointee
                        var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                        if inet_ntop(AF_INET, &sin.sin_addr, &buffer, socklen_t(INET_ADDRSTRLEN)) != nil {
                            ip = String(cString: buffer)
                        }
                    }
                }
                if !ip.isEmpty { break }
            }
        }

        var host = sender.hostName ?? ""
        while host.hasSuffix(".") { host = String(host.dropLast()) }

        let srvName = sender.name
        let port = sender.port > 0 ? sender.port : 445
        let resolvedHost = !ip.isEmpty ? ip : host

        let already = foundServers.contains { item in
            (item["host"] as? String == resolvedHost) || (item["name"] as? String == srvName)
        }

        if !already && (!srvName.isEmpty || !resolvedHost.isEmpty) {
            foundServers.append([
                "name": srvName,
                "host": resolvedHost,
                "ip": ip,
                "hostName": host,
                "port": port
            ])
        }
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        var host = sender.hostName ?? ""
        while host.hasSuffix(".") { host = String(host.dropLast()) }
        let srvName = sender.name
        let already = foundServers.contains { item in
            item["name"] as? String == srvName
        }
        if !already && !srvName.isEmpty {
            foundServers.append([
                "name": srvName,
                "host": host.isEmpty ? srvName : host,
                "ip": "",
                "hostName": host,
                "port": 445
            ])
        }
    }
}

/// Fallback discovery: many PCs (Windows especially) do not advertise SMB over Bonjour, so also
/// probe TCP port 445 on the phone's own /24 subnet plus any extra /24 subnets passed in.
enum SMBPortSweep {
    static func fmt(_ ip: UInt32) -> String {
        return "\((ip >> 24) & 255).\((ip >> 16) & 255).\((ip >> 8) & 255).\(ip & 255)"
    }

    static func parseIPv4(_ s: String) -> UInt32? {
        let parts = s.split(separator: ".").compactMap { UInt32($0) }
        guard parts.count == 4, parts.allSatisfy({ $0 < 256 }) else { return nil }
        return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]
    }

    /// "172.31.2.9", "172.31.2" or "172.31.2.0/24" -> 172.31.2.0
    static func block(from s: String) -> UInt32? {
        var t = s.trimmingCharacters(in: .whitespaces)
        if let slash = t.firstIndex(of: "/") { t = String(t[..<slash]) }
        var parts = t.split(separator: ".").map(String.init)
        guard parts.count >= 3 else { return nil }
        parts = Array(parts.prefix(3)) + ["0"]
        guard let ip = parseIPv4(parts.joined(separator: ".")) else { return nil }
        return ip & 0xFFFFFF00
    }

    static func wifiAddress() -> UInt32? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }
        var result: UInt32?
        var ptr: UnsafeMutablePointer<ifaddrs>? = first
        while let p = ptr {
            let ifa = p.pointee
            if let sa = ifa.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET), let namePtr = ifa.ifa_name {
                let name = String(cString: namePtr)
                if name.hasPrefix("en") {
                    let ip = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
                    if result == nil || name == "en0" { result = ip }
                }
            }
            ptr = ifa.ifa_next
        }
        return result
    }

    static func sweep(blocks: [UInt32], timeout: TimeInterval, completion: @escaping ([String]) -> Void) {
        let q = DispatchQueue(label: "smb.portsweep")
        q.async {
            var found: [String] = []
            var conns: [NWConnection] = []
            var finished = false
            for base in Set(blocks) {
                for last in 1...254 {
                    let host = fmt(base | UInt32(last))
                    let c = NWConnection(host: NWEndpoint.Host(host), port: 445, using: .tcp)
                    c.stateUpdateHandler = { state in
                        switch state {
                        case .ready:
                            if !found.contains(host) { found.append(host) }
                            c.cancel()
                        case .failed:
                            c.cancel()
                        default:
                            break
                        }
                    }
                    conns.append(c)
                    c.start(queue: q)
                }
            }
            q.asyncAfter(deadline: .now() + timeout) {
                if finished { return }
                finished = true
                conns.forEach { $0.cancel() }
                completion(found)
            }
        }
    }
}

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
        CAPPluginMethod(name: "move", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discoverServers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listShares", returnType: CAPPluginReturnPromise)
    ]

    private let lock = NSLock()
    private var sessions: [String: SMB2Manager] = [:]
    private var uploads: [String: URL] = [:]
    private var activeDiscovery: SMBBonjourDiscovery?

    // MARK: - Helpers

    private func parseHostAndShare(rawHost: String, rawShare: String?) -> (host: String, port: Int, share: String) {
        var host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines)
        if host.lowercased().hasPrefix("smb://") {
            host = String(host.dropFirst(6))
        }
        var sh = (rawShare ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        while sh.hasPrefix("/") { sh = String(sh.dropFirst()) }
        while sh.hasSuffix("/") { sh = String(sh.dropLast()) }

        if let slashIdx = host.firstIndex(of: "/") {
            let pathPart = String(host[host.index(after: slashIdx)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            host = String(host[..<slashIdx])
            if sh.isEmpty && !pathPart.isEmpty {
                sh = pathPart
            }
        }
        while host.hasSuffix("/") { host = String(host.dropLast()) }

        var port = 0
        if let colonIdx = host.lastIndex(of: ":"), colonIdx > host.startIndex {
            let portStr = String(host[host.index(after: colonIdx)...])
            if let p = Int(portStr) {
                port = p
                host = String(host[..<colonIdx])
            }
        }
        return (host, port, sh)
    }

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

    // MARK: - Auto-Discovery & Share Enumeration

    @objc func discoverServers(_ call: CAPPluginCall) {
        let timeout = call.getDouble("timeout") ?? 3.5
        let hints = call.getArray("hints", String.self) ?? []

        var blocks: [UInt32] = []
        if let mine = SMBPortSweep.wifiAddress() { blocks.append(mine & 0xFFFFFF00) }
        for h in hints { if let b = SMBPortSweep.block(from: h) { blocks.append(b) } }

        var bonjour: [[String: Any]] = []
        var swept: [String] = []
        let group = DispatchGroup()

        // NetServiceBrowser needs a running run loop, so it must be started on the main thread.
        group.enter()
        DispatchQueue.main.async {
            let discovery = SMBBonjourDiscovery()
            self.activeDiscovery = discovery
            discovery.discover(timeout: timeout) { servers in
                bonjour = servers
                group.leave()
            }
        }

        group.enter()
        if blocks.isEmpty {
            group.leave()
        } else {
            SMBPortSweep.sweep(blocks: blocks, timeout: min(timeout, 3.0)) { ips in
                swept = ips
                group.leave()
            }
        }

        group.notify(queue: .main) { [weak self] in
            self?.activeDiscovery = nil
            var merged = bonjour
            for ip in swept {
                let known = merged.contains { ($0["host"] as? String) == ip || ($0["ip"] as? String) == ip }
                if !known {
                    merged.append(["name": ip, "host": ip, "ip": ip, "hostName": "", "port": 445])
                }
            }
            call.resolve(["servers": merged])
        }
    }

    @objc func listShares(_ call: CAPPluginCall) {
        guard let rawHost = call.getString("host"), !rawHost.isEmpty else {
            call.reject("Missing host"); return
        }

        let parsed = parseHostAndShare(rawHost: rawHost, rawShare: nil)
        let host = parsed.host
        let port = call.getInt("port") ?? parsed.port

        let user = call.getString("username") ?? "guest"
        let pass = call.getString("password") ?? ""
        let domain = call.getString("domain") ?? ""

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
                let shares = try await manager.listShares(enumerateHidden: false)
                let entries = shares.map { share -> [String: String] in
                    return ["name": share.name, "comment": share.comment]
                }
                call.resolve(["shares": entries])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    // MARK: - Connection

    @objc func connect(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let rawHost = call.getString("host"), !rawHost.isEmpty else {
            call.reject("Missing host"); return
        }

        let rawShare = call.getString("share")
        let parsed = parseHostAndShare(rawHost: rawHost, rawShare: rawShare)
        let host = parsed.host
        let share = parsed.share
        let port = call.getInt("port") ?? parsed.port

        guard !share.isEmpty else {
            call.reject("Missing share name"); return
        }

        let user = call.getString("username") ?? "guest"
        let pass = call.getString("password") ?? ""
        let domain = call.getString("domain") ?? ""

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

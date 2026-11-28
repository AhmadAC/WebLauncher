import Foundation
import Capacitor
import UIKit

// Receives weblauncher://launch?app=<id> links (home-screen shortcuts) and lets JS open external URLs.
@objc(LaunchLinkPlugin)
public class LaunchLinkPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LaunchLinkPlugin"
    public let jsName = "LaunchLink"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getLaunchUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise)
    ]

    private static var lastUrl: String?

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(onOpenUrl(_:)),
                                               name: .capacitorOpenURL, object: nil)
    }

    @objc private func onOpenUrl(_ note: Notification) {
        guard let obj = note.object as? [String: Any], let url = obj["url"] as? URL else { return }
        guard url.scheme?.lowercased() == "weblauncher" else { return }
        LaunchLinkPlugin.lastUrl = url.absoluteString
        notifyListeners("urlOpen", data: ["url": url.absoluteString], retainUntilConsumed: true)
    }

    // URL that started/resumed the app (cleared once read).
    @objc func getLaunchUrl(_ call: CAPPluginCall) {
        let u = LaunchLinkPlugin.lastUrl
        LaunchLinkPlugin.lastUrl = nil
        call.resolve(["url": u ?? NSNull()])
    }

    @objc func openExternal(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s) else {
            call.reject("bad url"); return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in call.resolve(["opened": ok]) }
        }
    }
}

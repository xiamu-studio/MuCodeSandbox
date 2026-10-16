import Foundation
import SystemConfiguration

var sequence = 0
var previous: String?
let patterns = ["^State:/Network/Global/.*", "^State:/Network/Service/[^/]+/(IPv4|IPv6|DNS|Proxies)$", "^State:/Network/Interface/[^/]+/(IPv4|IPv6|Link|AirPort)$"] as CFArray

func failure(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
func sample(_ store: SCDynamicStore, forceChange: Bool = false) {
    guard let values = SCDynamicStoreCopyMultiple(store, nil, patterns) as? [String: Any] else { failure("Cannot read system network state") }
    do {
        let fingerprint = try networkFingerprint(values)
        let kind = previous == nil ? "ready" : (forceChange || fingerprint != previous ? "change" : "heartbeat")
        sequence += 1
        let bytes = try JSONSerialization.data(withJSONObject: ["kind": kind, "fingerprint": fingerprint, "sequence": sequence], options: [.sortedKeys])
        FileHandle.standardOutput.write(bytes + Data([10]))
        previous = fingerprint
    } catch { failure("Cannot encode system network state") }
}

@main struct NetworkMonitor {
    static func main() {
        guard let store = SCDynamicStoreCreate(nil, "MuCodeSandbox Network Monitor" as CFString, { store, keys, _ in
            // An empty callback means configd restarted; the prior baseline is no longer valid.
            sample(store, forceChange: CFArrayGetCount(keys) == 0)
        }, nil) else { failure("Cannot connect to system network state") }
        guard SCDynamicStoreSetNotificationKeys(store, nil, patterns),
              let source = SCDynamicStoreCreateRunLoopSource(nil, store, 0) else { failure("Cannot subscribe to system network changes") }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
        sample(store)
        if CommandLine.arguments.contains("--once") { exit(0) }
        let timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in sample(store) }
        withExtendedLifetime(timer) { CFRunLoopRun() }
        failure("System network monitor stopped")
    }
}

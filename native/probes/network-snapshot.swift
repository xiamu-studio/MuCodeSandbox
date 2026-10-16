import Foundation

@main struct NetworkSnapshotProbe {
    static func main() throws {
        let base: [String: Any] = [
            "State:/Network/Global/IPv4": ["PrimaryService": "wifi", "PrimaryInterface": "en0", "Router": "192.0.2.1"],
            "State:/Network/Service/wifi/IPv4": ["Addresses": ["192.0.2.2"], "Router": "192.0.2.1"],
            "State:/Network/Service/wifi/IPv6": ["Addresses": ["2001:db8::1"]],
            "State:/Network/Global/DNS": ["ServerAddresses": ["192.0.2.53"]],
            "State:/Network/Interface/en0/Link": ["Active": true],
            "State:/Network/Interface/en0/AirPort": ["SSID_STR": "fixture", "BSSID": Data([1, 2, 3])]
        ]
        let fingerprint = try networkFingerprint(base)
        func require(_ value: Bool, _ message: String) { if !value { fatalError(message) } }
        var checks = 0
        let changes: [(String, [String: Any])] = [
            ("State:/Network/Global/IPv4", ["PrimaryService": "vpn", "PrimaryInterface": "utun1", "Router": "192.0.2.1"]),
            ("State:/Network/Service/wifi/IPv4", ["Addresses": ["192.0.2.3"]]),
            ("State:/Network/Service/wifi/IPv6", ["Addresses": ["2001:db8::2"]]),
            ("State:/Network/Global/DNS", ["ServerAddresses": ["192.0.2.54"]]),
            ("State:/Network/Service/vpn/DNS", ["ServerAddresses": ["192.0.2.55"], "SupplementalMatchDomains": ["private.test"]]),
            ("State:/Network/Global/Proxies", ["HTTPEnable": 1, "HTTPProxy": "192.0.2.80"]),
            ("State:/Network/Interface/en0/Link", ["Active": false]),
            ("State:/Network/Interface/en0/AirPort", ["SSID_STR": "other", "BSSID": Data([4, 5, 6])])
        ]
        for (key, value) in changes {
            var changed = base; changed[key] = value
            require(try networkFingerprint(changed) != fingerprint, "Network change was missed: \(key)")
            checks += 1
        }
        var virtual = base
        virtual["State:/Network/Service/vm/IPv4"] = ["Addresses": ["192.168.105.2"]]
        virtual["State:/Network/Interface/bridge100/Link"] = ["Active": true]
        require(try networkFingerprint(virtual) == fingerprint, "VM interfaces must not change the host baseline")
        var telemetry = base
        telemetry["State:/Network/Interface/en0/AirPort"] = ["SSID_STR": "fixture", "BSSID": Data([1, 2, 3]), "RSSI": -60]
        require(try networkFingerprint(telemetry) == fingerprint, "Signal-strength telemetry must not stop a guest")
        var removed = base; removed.removeValue(forKey: "State:/Network/Global/IPv4")
        require(try networkFingerprint(removed) != fingerprint, "Loss of a route must invalidate the baseline")
        require(try networkFingerprint(Dictionary(uniqueKeysWithValues: base.reversed())) == fingerprint, "Dictionary order must not affect the fingerprint")
        print("{\"passed\":true,\"fixtureChecks\":\(checks + 4),\"actualNetworkChanged\":false}")
    }
}

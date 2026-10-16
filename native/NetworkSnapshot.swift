import Foundation
import CryptoKit

func networkFingerprint(_ values: [String: Any]) throws -> String {
    var selected: [String: Any] = [:]
    var services = Set<String>()
    var interfaces = Set<String>()
    for entity in ["IPv4", "IPv6", "DNS", "Proxies"] {
        let key = "State:/Network/Global/\(entity)"
        if let value = values[key] as? [String: Any] {
            selected[key] = value
            if let service = value["PrimaryService"] as? String { services.insert(service) }
            if let interface = value["PrimaryInterface"] as? String { interfaces.insert(interface) }
        }
    }
    for (key, value) in values {
        let parts = key.split(separator: "/")
        if parts.count == 5 && parts[2] == "Service" {
            let entity = String(parts[4])
            // Supplemental DNS and proxies can affect traffic beyond the primary service.
            if entity == "DNS" || entity == "Proxies" || (services.contains(String(parts[3])) && ["IPv4", "IPv6"].contains(entity)) {
                selected[key] = value
            }
        }
        if parts.count == 5 && parts[2] == "Interface" && interfaces.contains(String(parts[3])) {
            let entity = String(parts[4])
            if ["IPv4", "IPv6", "Link", "AirPort"].contains(entity), let properties = value as? [String: Any] {
                let fields = ["Addresses", "SubnetMasks", "PrefixLength", "Router", "Active", "SSID_STR", "BSSID", "NetworkID"]
                selected[key] = properties.filter { fields.contains($0.key) }
            }
        }
    }
    func jsonValue(_ value: Any) -> Any {
        if let data = value as? Data { return ["data": data.base64EncodedString()] }
        if let date = value as? Date { return ["date": date.timeIntervalSince1970] }
        if let dict = value as? [String: Any] { return dict.mapValues(jsonValue) }
        if let array = value as? [Any] { return array.map(jsonValue) }
        return value
    }
    let bytes = try JSONSerialization.data(withJSONObject: jsonValue(selected), options: [.sortedKeys])
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
}

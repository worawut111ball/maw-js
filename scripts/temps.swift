// Prints Mac temperatures as JSON — no sudo. Reads the Apple Silicon sensors the same way monitoring apps do
// (IOHIDEventSystemClient, temperature usage page). Build: swiftc -O scripts/temps.swift -o ~/.maw/bin/temps
// Output: {"cpu":{"avg":48.1,"max":55.3,"n":12},"gpu":{...},"battery":31.2,"ssd":36.0,"sensors":24}
import Foundation
import IOKit

typealias ClientCreate = @convention(c) (CFAllocator?) -> Unmanaged<AnyObject>?
typealias SetMatching = @convention(c) (AnyObject, CFDictionary) -> Int32
typealias CopyServices = @convention(c) (AnyObject) -> Unmanaged<CFArray>?
typealias CopyProperty = @convention(c) (AnyObject, CFString) -> Unmanaged<CFTypeRef>?
typealias CopyEvent = @convention(c) (AnyObject, Int64, Int32, Int64) -> Unmanaged<AnyObject>?
typealias GetFloat = @convention(c) (AnyObject, Int32) -> Double

let h = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW)
func sym<T>(_ n: String, _ t: T.Type) -> T? { guard let p = dlsym(h, n) else { return nil }; return unsafeBitCast(p, to: t) }
guard let create = sym("IOHIDEventSystemClientCreate", ClientCreate.self),
      let setMatching = sym("IOHIDEventSystemClientSetMatching", SetMatching.self),
      let copyServices = sym("IOHIDEventSystemClientCopyServices", CopyServices.self),
      let copyProp = sym("IOHIDServiceClientCopyProperty", CopyProperty.self),
      let copyEvent = sym("IOHIDServiceClientCopyEvent", CopyEvent.self),
      let getFloat = sym("IOHIDEventGetFloatValue", GetFloat.self),
      let client = create(kCFAllocatorDefault)?.takeRetainedValue() else { print("{}"); exit(0) }

let kTemperatureEvent: Int64 = 15                       // kIOHIDEventTypeTemperature
let kTemperatureField: Int32 = Int32(kTemperatureEvent << 16)
_ = setMatching(client, ["PrimaryUsagePage": 0xff00, "PrimaryUsage": 5] as CFDictionary)   // Apple vendor page · temperature

var cpu: [Double] = [], gpu: [Double] = [], battery: [Double] = [], ssd: [Double] = [], count = 0
if let services = copyServices(client)?.takeRetainedValue() as? [AnyObject] {
  for s in services {
    guard let name = copyProp(s, "Product" as CFString)?.takeRetainedValue() as? String,
          let ev = copyEvent(s, kTemperatureEvent, 0, 0)?.takeRetainedValue() else { continue }
    let t = getFloat(ev, kTemperatureField)
    guard t > 5 && t < 130 else { continue }
    count += 1
    let n = name.lowercased()
    if n.contains("tdie") || n.contains("cpu") || n.hasPrefix("pmu tp") || n.contains("soc") { cpu.append(t) }
    else if n.contains("gpu") { gpu.append(t) }
    else if n.contains("battery") || n.contains("gas gauge") { battery.append(t) }
    else if n.contains("nand") || n.contains("ssd") { ssd.append(t) }
  }
}
func r(_ x: Double) -> Double { (x * 10).rounded() / 10 }
func group(_ a: [Double]) -> [String: Any]? { a.isEmpty ? nil : ["avg": r(a.reduce(0, +) / Double(a.count)), "max": r(a.max()!), "n": a.count] }
var out: [String: Any] = ["sensors": count]
if let g = group(cpu) { out["cpu"] = g }
if let g = group(gpu) { out["gpu"] = g }
if let b = battery.max() { out["battery"] = r(b) }
if let s = ssd.max() { out["ssd"] = r(s) }
let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)

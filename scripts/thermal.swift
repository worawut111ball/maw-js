// Prints macOS thermal state: 0 nominal · 1 fair · 2 serious · 3 critical (same signal macOS uses to throttle).
// Build: swiftc -O scripts/thermal.swift -o ~/.maw/bin/thermal
import Foundation
print(ProcessInfo.processInfo.thermalState.rawValue)

import Foundation

actor Pause {
	private var arrived = false
	private var arrival: CheckedContinuation<Void, Never>?
	private var blocked: CheckedContinuation<Void, Never>?

	func stop() async {
		arrived = true
		arrival?.resume()
		arrival = nil
		await withCheckedContinuation { blocked = $0 }
	}

	func waitForArrival() async {
		if arrived { return }
		await withCheckedContinuation { arrival = $0 }
	}

	func proceed() {
		blocked?.resume()
		blocked = nil
	}
}

actor Terminals {
	private var events: [String] = []

	func record(_ request: String, _ outcome: String) {
		events.append("\(request):\(outcome)")
	}

	func assertEvents(_ expected: [String]) {
		precondition(events == expected, "Expected \(expected), got \(events)")
	}
}

func request(_ name: String, gate: Gate, terminals: Terminals, pause: Pause? = nil) async -> Bool {
	guard await gate.acquire() else {
		await terminals.record(name, "cancelled")
		return false
	}
	if let pause { await pause.stop() }
	await terminals.record(name, Task.isCancelled ? "cancelled" : "done")
	await gate.release()
	return true
}

@main enum GateTest {
	static func main() async {
		await cancelQueued()
		await cancelAfterHandoff()
		print("Apple Foundation Models gate tests passed")
	}

	private static func cancelQueued() async {
		let gate = Gate()
		let terminals = Terminals()
		let pauseC = Pause()
		let ownsA = await gate.acquire()
		precondition(ownsA)
		let b = Task { await request("B", gate: gate, terminals: terminals) }
		await gate.waitForQueued(1)
		let c = Task { await request("C", gate: gate, terminals: terminals, pause: pauseC) }
		await gate.waitForQueued(2)

		b.cancel()
		b.cancel()
		let ownsB = await b.value
		precondition(!ownsB, "Queued cancellation must resolve without releasing A")
		await terminals.assertEvents(["B:cancelled"])

		await gate.release()
		await pauseC.waitForArrival()
		let d = Task { await request("D", gate: gate, terminals: terminals) }
		await gate.waitForQueued(1)
		await pauseC.proceed()
		let ownsC = await c.value
		let ownsD = await d.value
		precondition(ownsC && ownsD)
		await terminals.assertEvents(["B:cancelled", "C:done", "D:done"])
	}

	private static func cancelAfterHandoff() async {
		let gate = Gate()
		let terminals = Terminals()
		let pauseB = Pause()
		let pauseC = Pause()
		let ownsA = await gate.acquire()
		precondition(ownsA)
		let b = Task { await request("B", gate: gate, terminals: terminals, pause: pauseB) }
		await gate.waitForQueued(1)
		let c = Task { await request("C", gate: gate, terminals: terminals, pause: pauseC) }
		await gate.waitForQueued(2)

		await gate.release()
		await pauseB.waitForArrival()
		b.cancel()
		b.cancel()
		await pauseB.proceed()
		let ownsB = await b.value
		precondition(ownsB, "Handoff before cancellation must retain ownership")
		await pauseC.waitForArrival()
		await terminals.assertEvents(["B:cancelled"])

		let d = Task { await request("D", gate: gate, terminals: terminals) }
		await gate.waitForQueued(1)
		await pauseC.proceed()
		let ownsC = await c.value
		let ownsD = await d.value
		precondition(ownsC && ownsD)
		await terminals.assertEvents(["B:cancelled", "C:done", "D:done"])
	}
}

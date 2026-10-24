import { spyOn } from "bun:test";
import { IpcConnection } from "@oh-my-pi/pi-natives";

/** Hold JS delivery while the independent native actor consumes the peer's EOF. */
export function gateNativeDeliveryUntilEof(): {
	arm(beforeDelivery?: () => void): void;
	closed: Promise<void>;
	restore(): void;
} {
	let armed = false;
	let beforeDelivery: (() => void) | undefined;
	let gated: IpcConnection | undefined;
	const closed = Promise.withResolvers<void>();
	const start = IpcConnection.prototype.start;
	const spy = spyOn(IpcConnection.prototype, "start").mockImplementation(
		function (this: IpcConnection, onFrame, onClose) {
			return start.call(
				this,
				line => {
					if (armed) {
						armed = false;
						gated = this;
						const deadline = performance.now() + 3000;
						while (!this.closed) {
							if (performance.now() >= deadline)
								throw new Error("native peer EOF did not arrive before delivery");
						}
						beforeDelivery?.();
					}
					onFrame(line);
				},
				reason => {
					onClose(reason);
					if (gated === this) closed.resolve();
				},
			);
		},
	);
	return {
		arm: action => {
			armed = true;
			beforeDelivery = action;
		},
		closed: closed.promise,
		restore: () => spy.mockRestore(),
	};
}

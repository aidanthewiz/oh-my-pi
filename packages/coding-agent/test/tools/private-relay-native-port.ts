import { NATIVE_HOST } from "../../../browser-relay/extension/messages";
import { isLoopbackRelayUrl } from "../../src/tools/browser/relay/kind";

/** Replace OS host registration only; the real extension still drives the real loopback relay and Chrome debugger. */
export function privateRelayNativePort(relayUrl: string, token: string): string {
	const endpoint = new URL(relayUrl);
	if (!isLoopbackRelayUrl(relayUrl) || !token || endpoint.username || endpoint.password) {
		throw new Error("The native-port fixture requires a credential-free loopback URL and a synthetic token");
	}
	endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
	endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/ext`;
	endpoint.search = "";
	endpoint.searchParams.set("token", token);
	return `(() => {
	const endpoint = ${JSON.stringify(endpoint.toString())};
	chrome.runtime.connectNative = name => {
		if (name !== ${JSON.stringify(NATIVE_HOST)}) throw new Error("Unexpected native host identity");
		const socket = new WebSocket(endpoint);
		const messages = new Set();
		const disconnects = new Set();
		let requested = false;
		let linked = false;
		let disconnected = false;
		let selfClosed = false;
		const notifyLinked = () => {
			if (!requested || linked || socket.readyState !== WebSocket.OPEN) return;
			linked = true;
			for (const listener of messages) listener({ t: "linked" });
		};
		const notifyDisconnected = () => {
			if (selfClosed || disconnected) return;
			disconnected = true;
			for (const listener of disconnects) listener();
		};
		socket.addEventListener("open", notifyLinked);
		socket.addEventListener("message", event => {
			for (const listener of messages) listener({ t: "relay", line: String(event.data) });
		});
		socket.addEventListener("close", notifyDisconnected);
		socket.addEventListener("error", notifyDisconnected);
		return {
			name,
			onMessage: { addListener: listener => messages.add(listener) },
			onDisconnect: { addListener: listener => disconnects.add(listener) },
			postMessage(message) {
				if (message.t === "link") {
					if (message.extensionId !== chrome.runtime.id) throw new Error("Unexpected extension identity");
					requested = true;
					notifyLinked();
				} else if (message.t === "relay" && linked && socket.readyState === WebSocket.OPEN) {
					socket.send(message.line);
				} else {
					throw new Error("Unsupported or disconnected native-port fixture message");
				}
			},
			disconnect() { selfClosed = true; socket.close(); },
		};
	};
})();\n`;
}

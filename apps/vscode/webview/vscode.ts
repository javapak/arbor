import type { WebviewMessage } from '../src/protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

/** The one handle VS Code gives a webview; acquiring it twice throws. */
const api = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
    api.postMessage(message);
}

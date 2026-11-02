// Test-only transport substitution. Lifecycle fixtures exercise real CLI behavior
// against a fake model; production endpoint enforcement is tested separately.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
const { CopilotWebSocketHandler, CopilotWebSocketCloseStatus } = await import(pathToFileURL(join(process.env.SUPERAGENT_TEST_SDK, 'dist/index.js')).href);

export function fixtureTransport(handler, origin) {
    const expected = new URL(origin);
    assert.equal(expected.hostname, '127.0.0.1');
    assert.equal(expected.protocol, 'http:');
    const within = (url, websocket = false) => {
        const target = new URL(url);
        assert.equal(target.origin, websocket ? origin.replace(/^http:/, 'ws:') : origin);
        assert.equal(target.username, '');
        assert.equal(target.password, '');
    };
    handler.sendRequest = async (request, context) => {
        within(request.url); within(context.url);
        const body = await request.clone().json();
        const owner = handler.rewrite(body, context);
        const headers = new Headers(request.headers); headers.delete('content-length');
        return fetch(new Request(request, { headers, body: JSON.stringify(body), redirect: 'error',
            signal: AbortSignal.any([request.signal, context.signal, owner.signal]) }));
    };
    handler.openWebSocket = async context => {
        within(context.url, true);
        return await new FixtureSocket(context, handler, within).open();
    };
}

class FixtureSocket extends CopilotWebSocketHandler {
    constructor(context, handler, within) {
        super(context);
        this.handler = handler;
        this.within = within;
        const headers = Object.fromEntries(Object.entries(context.headers).filter(([, value]) => value));
        this.socket = new WebSocket(context.url, { headers, followRedirects: false, handshakeTimeout: 3000 });
        this.ready = new Promise((resolve, reject) => {
            this.socket.once('open', resolve);
            this.socket.once('error', reject);
            this.socket.once('close', () => reject(new Error('Fixture socket closed before opening')));
        });
        this.socket.on('message', (bytes, binary) => {
            void this.sendResponseMessage(binary ? new Uint8Array(bytes) : bytes.toString()).catch(() => this.close());
        });
        this.socket.on('close', () => { void this.close(); });
        this.socket.on('error', () => { void this.close(new CopilotWebSocketCloseStatus('Fixture socket error')); });
        this.abort = () => { void this.close(new CopilotWebSocketCloseStatus('Fixture request cancelled')); };
        context.signal.addEventListener('abort', this.abort, { once: true });
        if (context.signal.aborted) this.abort();
    }
    async open() { await this.ready; this.context.signal.throwIfAborted(); return this; }
    async sendRequestMessage(data, context = this.context) {
        this.within(context.url, true);
        const body = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
        assert.equal(body.type, 'response.create');
        const owner = this.handler.rewrite(body, context);
        await this.ready;
        owner.assertCurrent(); owner.signal.throwIfAborted(); context.signal.throwIfAborted();
        await new Promise((resolve, reject) => this.socket.send(JSON.stringify(body), error => error ? reject(error) : resolve()));
    }
    async close(status = CopilotWebSocketCloseStatus.normalClosure) {
        if (this.closed) return;
        this.closed = true;
        this.context.signal.removeEventListener('abort', this.abort);
        this.socket.terminate();
        await super.close(status);
    }
}

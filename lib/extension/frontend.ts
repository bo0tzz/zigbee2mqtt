import type {IncomingMessage, Server, ServerResponse} from "node:http";
import type {Socket} from "node:net";

import type {RequestHandler} from "express-static-gzip";

import assert from "node:assert";
import {existsSync, readFileSync} from "node:fs";
import {createServer} from "node:http";
import {createServer as createSecureServer} from "node:https";
import {posix} from "node:path";
import {parse} from "node:url";

import bind from "bind-decorator";
import expressStaticGzip from "express-static-gzip";
import finalhandler from "finalhandler";
import stringify from "json-stable-stringify-without-jsonify";
import WebSocket from "ws";

import frontend from "zigbee2mqtt-frontend";

import data from "../util/data";
import logger from "../util/logger";
import * as settings from "../util/settings";
import utils from "../util/utils";
import Extension from "./extension";

/**
 * This extension servers the frontend
 */
export class Frontend extends Extension {
    private mqttBaseTopic: string;
    private host: string | undefined;
    private port: number;
    private sslCert: string | undefined;
    private sslKey: string | undefined;
    private authToken: string | undefined;
    private server!: Server;
    private fileServer!: RequestHandler;
    private deviceIconsFileServer!: RequestHandler;
    private wss!: WebSocket.Server;
    private baseUrl: string;

    constructor(
        zigbee: Zigbee,
        mqtt: Mqtt,
        state: State,
        publishEntityState: PublishEntityState,
        eventBus: EventBus,
        enableDisableExtension: (enable: boolean, name: string) => Promise<void>,
        restartCallback: () => Promise<void>,
        addExtension: (extension: Extension) => Promise<void>,
    ) {
        super(zigbee, mqtt, state, publishEntityState, eventBus, enableDisableExtension, restartCallback, addExtension);

        const frontendSettings = settings.get().frontend;
        assert(frontendSettings.enabled, `Frontend extension created with setting 'enabled: false'`);
        this.host = frontendSettings.host;
        this.port = frontendSettings.port;
        this.sslCert = frontendSettings.ssl_cert;
        this.sslKey = frontendSettings.ssl_key;
        this.authToken = frontendSettings.auth_token;
        this.baseUrl = frontendSettings.base_url;
        this.mqttBaseTopic = settings.get().mqtt.base_topic;
    }

    private isHttpsConfigured(): boolean {
        if (this.sslCert && this.sslKey) {
            if (!existsSync(this.sslCert) || !existsSync(this.sslKey)) {
                logger.error(`defined ssl_cert '${this.sslCert}' or ssl_key '${this.sslKey}' file path does not exists, server won't be secured.`);
                return false;
            }
            return true;
        }
        return false;
    }

    override async start(): Promise<void> {
        const options = {
            enableBrotli: true,
            // TODO: https://github.com/Koenkk/zigbee2mqtt/issues/24654 - enable compressed index serving when express-static-gzip is fixed.
            index: false,
            serveStatic: {
                index: "index.html",
                /* v8 ignore start */
                setHeaders: (res: ServerResponse, path: string): void => {
                    if (path.endsWith("index.html")) {
                        res.setHeader("Cache-Control", "no-store");
                    }
                },
                /* v8 ignore stop */
            },
        };
        this.fileServer = expressStaticGzip(frontend.getPath(), options);
        this.deviceIconsFileServer = expressStaticGzip(data.joinPath("device_icons"), options);
        this.wss = new WebSocket.Server({noServer: true, path: posix.join(this.baseUrl, "api")});

        this.wss.on("connection", this.onWebSocketConnection);

        if (this.isHttpsConfigured()) {
            // biome-ignore lint/style/noNonNullAssertion: valid from `isHttpsConfigured`
            const serverOptions = {key: readFileSync(this.sslKey!), cert: readFileSync(this.sslCert!)};
            this.server = createSecureServer(serverOptions, this.onRequest);
        } else {
            this.server = createServer(this.onRequest);
        }

        this.server.on("upgrade", this.onUpgrade);
        this.eventBus.onMQTTMessagePublished(this, this.onMQTTPublishMessageOrEntityState);
        this.eventBus.onPublishEntityState(this, this.onMQTTPublishMessageOrEntityState);

        if (!this.host) {
            this.server.listen(this.port);
            logger.info(`Started frontend on port ${this.port}`);
        } else if (this.host.startsWith("/")) {
            this.server.listen(this.host);
            logger.info(`Started frontend on socket ${this.host}`);
        } else {
            this.server.listen(this.port, this.host);
            logger.info(`Started frontend on port ${this.host}:${this.port}`);
        }
    }

    override async stop(): Promise<void> {
        await super.stop();

        if (this.wss) {
            for (const client of this.wss.clients) {
                client.send(stringify({topic: "bridge/state", payload: {state: "offline"}}));
                client.terminate();
            }

            this.wss.close();
        }

        await new Promise((resolve) => this.server?.close(resolve));
    }

    @bind private onRequest(request: IncomingMessage, response: ServerResponse): void {
        const fin = finalhandler(request, response);
        // biome-ignore lint/style/noNonNullAssertion: `Only valid for request obtained from Server`
        const newUrl = posix.relative(this.baseUrl, request.url!);

        // The request url is not within the frontend base url, so the relative path starts with '..'
        if (newUrl.startsWith(".")) {
            fin();

            return;
        }

        // Attach originalUrl so that static-server can perform a redirect to '/' when serving the root directory.
        // This is necessary for the browser to resolve relative assets paths correctly.
        request.originalUrl = request.url;
        request.url = `/${newUrl}`;
        request.path = request.url;

        if (newUrl.startsWith("device_icons/")) {
            request.path = request.path.replace("device_icons/", "");
            request.url = request.url.replace("/device_icons", "");
            this.deviceIconsFileServer(request, response, fin);
        } else {
            this.fileServer(request, response, fin);
        }
    }

    private authenticate(request: IncomingMessage, cb: (authenticate: boolean) => void): void {
        // biome-ignore lint/style/noNonNullAssertion: `Only valid for request obtained from Server`
        const {query} = parse(request.url!, true);
        cb(!this.authToken || this.authToken === query.token);
    }

    @bind private onUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.authenticate(request, (isAuthenticated) => {
                if (isAuthenticated) {
                    this.wss.emit("connection", ws, request);
                } else {
                    ws.close(4401, "Unauthorized");
                }
            });
        });
    }

    @bind private onWebSocketConnection(ws: WebSocket): void {
        ws.on("error", (msg) => logger.error(`WebSocket error: ${msg.message}`));
        ws.on("message", (data: Buffer, isBinary: boolean) => {
            if (!isBinary && data) {
                const message = data.toString();
                const {topic, payload} = JSON.parse(message);
                this.mqtt.onMessage(`${this.mqttBaseTopic}/${topic}`, Buffer.from(stringify(payload)));
            }
        });

        for (const [topic, payload] of Object.entries(this.mqtt.retainedMessages)) {
            if (topic.startsWith(`${this.mqttBaseTopic}/`)) {
                ws.send(
                    stringify({
                        // Send topic without base_topic
                        topic: topic.substring(this.mqttBaseTopic.length + 1),
                        payload: utils.parseJSON(payload.payload, payload.payload),
                    }),
                );
            }
        }

        for (const device of this.zigbee.devicesIterator(utils.deviceNotCoordinator)) {
            const payload = this.state.get(device);
            const lastSeen = settings.get().advanced.last_seen;

            if (lastSeen !== "disable") {
                payload.last_seen = utils.formatDate(device.zh.lastSeen ?? /* v8 ignore next */ 0, lastSeen);
            }

            if (device.zh.linkquality !== undefined) {
                payload.linkquality = device.zh.linkquality;
            }

            ws.send(stringify({topic: device.name, payload}));
        }
    }

    @bind private onMQTTPublishMessageOrEntityState(data: eventdata.MQTTMessagePublished | eventdata.PublishEntityState): void {
        let topic: string;
        let payload: KeyValue | string;

        if ("topic" in data) {
            // MQTTMessagePublished
            if (data.options.meta.isEntityState || !data.topic.startsWith(`${this.mqttBaseTopic}/`)) {
                // Don't send entity state to frontend on `MQTTMessagePublished` event, this is handled by
                // `PublishEntityState` instead. Reason for this is to skip attribute messages when `output` is
                // set to `attribute` or `attribute_and_json`, we only want to send JSON entity states to the
                // frontend.
                return;
            }
            // Send topic without base_topic
            topic = data.topic.substring(this.mqttBaseTopic.length + 1);
            payload = utils.parseJSON(data.payload, data.payload);
        } else {
            // PublishEntityState
            topic = data.entity.name;
            payload = data.payload;
        }

        for (const client of this.wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(stringify({topic, payload}));
            }
        }
    }
}

export default Frontend;

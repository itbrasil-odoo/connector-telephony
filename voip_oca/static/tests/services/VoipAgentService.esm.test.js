/*
    Copyright 2025 Dixmit
    License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).
*/
import {VoipAgent, reconnectDelay} from "@voip_oca/services/voip_agent_service.esm";
import {advanceTime, after, animationFrame, expect, test} from "@odoo/hoot";
import {allowTranslations, patchWithCleanup} from "@web/../tests/web_test_helpers";

const PASSWORD = "s3cr3t-test-pw";

/*
    The fakes below mimic the vendored SIP.js 0.21.2 (static/lib/sip.js), not
    the service under test:
    - UserAgent.start() moves to Started BEFORE connecting (sip.js:8916-8917).
      If the connection fails the state stays Started, and a second start()
      only warns "already started" and resolves WITHOUT connecting
      (8911-8913). Only reconnect() retries the transport (8885-8892).
    - The transport leaves Connected -> onDisconnect fires, and only then
      (11203-11215).
    - A REGISTER sent over a disconnected transport yields an internal 503
      that reaches the delegate as onReject (10987-10989, 13348-13355); the
      Registerer goes to Unregistered BEFORE the delegate is called
      (7767-7771).
    - A refused refresh or an expired registration goes to Unregistered
      through stateChange only, the delegate is not called (7751-7758, 7589).
    - register() rejects with RequestPendingError while a REGISTER is pending.
*/
function setupAgent({
    failReconnects = 0,
    failStarts = 0,
    failCreation = false,
    registerStatus = 200,
    holdRegister = false,
} = {}) {
    allowTranslations();
    const calls = {register: 0, unregister: 0, stop: 0, reconnect: 0, start: 0};
    const agents = [];
    const registerers = [];
    const net = {registerStatus, holdRegister, held: [], connects: 0};
    class RequestPendingError extends Error {}
    class FakeTransport {
        state = "Disconnected";
        constructor(agent) {
            this.agent = agent;
        }
        isConnected() {
            return this.state === "Connected";
        }
        async connect() {
            net.connects++;
            if (net.connects <= failStarts) {
                throw new Error("network down");
            }
            if (
                net.connects > failStarts + 1 &&
                net.connects <= failStarts + 1 + failReconnects
            ) {
                throw new Error("network down");
            }
            this.state = "Connected";
        }
        drop(error) {
            if (this.state === "Connected") {
                this.state = "Disconnected";
                // Only leaving Connected fires onDisconnect (sip.js:11203-11215)
                this.agent.options.delegate.onDisconnect(error);
            }
        }
    }
    class FakeUserAgent {
        static makeURI(uri) {
            return uri;
        }
        constructor(options) {
            if (failCreation) {
                throw new Error(`bad config: ${JSON.stringify(options)}`);
            }
            this.options = options;
            this.state = "Initial";
            this.stops = 0;
            this.reconnects = 0;
            this.transport = new FakeTransport(this);
            agents.push(this);
        }
        isConnected() {
            return this.transport.isConnected();
        }
        start() {
            calls.start++;
            if (this.state === "Started") {
                return Promise.resolve();
            }
            this.state = "Started";
            return this.transport.connect();
        }
        async stop() {
            calls.stop++;
            this.stops++;
            this.state = "Stopped";
            this.transport.drop();
        }
        reconnect() {
            calls.reconnect++;
            this.reconnects++;
            if (this.state === "Stopped") {
                return Promise.reject(new Error("User agent stopped."));
            }
            return Promise.resolve().then(() => this.transport.connect());
        }
    }
    class FakeRegisterer {
        state = "Initial";
        waiting = false;
        listeners = [];
        stateChange = {addListener: (listener) => this.listeners.push(listener)};
        constructor(agent) {
            this.agent = agent;
            registerers.push(this);
        }
        transition(state) {
            if (this.state !== state) {
                this.state = state;
                for (const listener of this.listeners) {
                    listener(state);
                }
            }
        }
        expire() {
            // Refused refresh / expired registration: no delegate call
            this.transition("Unregistered");
        }
        register(options = {}) {
            calls.register++;
            if (this.waiting) {
                return Promise.reject(new RequestPendingError("Request pending"));
            }
            this.waiting = true;
            const respond = () => {
                this.waiting = false;
                let status = net.registerStatus;
                if (!this.agent.isConnected()) {
                    status = 503;
                }
                const delegate = options.requestDelegate || {};
                if (status === 200) {
                    this.transition("Registered");
                    delegate.onAccept?.({message: {statusCode: 200}});
                } else {
                    this.transition("Unregistered");
                    delegate.onReject?.({
                        message: {statusCode: status, reasonPhrase: "rejected"},
                    });
                }
            };
            if (net.holdRegister) {
                net.held.push(respond);
            } else {
                Promise.resolve().then(respond);
            }
            return Promise.resolve();
        }
        async unregister() {
            calls.unregister++;
            this.transition("Unregistered");
        }
    }
    const previous = window.SIP;
    window.SIP = {
        UserAgent: FakeUserAgent,
        Registerer: FakeRegisterer,
        RegistererState: {
            Initial: "Initial",
            Registered: "Registered",
            Unregistered: "Unregistered",
            Terminated: "Terminated",
        },
        version: "test",
    };
    after(() => {
        window.SIP = previous;
    });
    patchWithCleanup(VoipAgent.prototype, {
        get hasRtcSupport() {
            return true;
        },
        async loadSipLibrary() {
            return true;
        },
    });
    const notifications = [];
    const errors = [];
    const sticky = [];
    patchWithCleanup(console, {
        error: (...args) => errors.push(args.map(String).join(" ")),
    });
    const agent = new VoipAgent(
        {},
        {
            voip_oca: {
                mode: "prod",
                pbx_ws: "wss://pbx.example.com",
                pbx_username: "100",
                pbx_password: PASSWORD,
                pbx_domain: "pbx.example.com",
                status: "disconnected",
            },
            multi_tab: {},
            orm: {},
            notification: {
                add: (message, options) => {
                    notifications.push(String(message));
                    if (options?.sticky) {
                        sticky.push(String(message));
                    }
                },
            },
            "mail.store": {},
        }
    );
    after(() => agent.stop());
    return {agent, agents, registerers, calls, net, notifications, errors, sticky};
}

test("reconnect delay grows and caps at 30s", () => {
    expect(reconnectDelay(0)).toBe(1000);
    expect(reconnectDelay(1)).toBe(2000);
    expect(reconnectDelay(5)).toBe(30000);
    expect(reconnectDelay(20)).toBe(30000);
});

test("reconnect never gives up", async () => {
    const {agent, agents, calls, notifications} = setupAgent({failReconnects: 10});
    await animationFrame();
    expect(agent.voip.status).toBe("connected");
    const registers = calls.register;
    agents[0].transport.drop(new Error("connection lost"));
    await animationFrame();
    for (let attempt = 0; attempt < 9; attempt++) {
        await advanceTime(reconnectDelay(attempt));
        await animationFrame();
    }
    expect(calls.reconnect).toBe(10);
    expect(agent.voip.status).toBe("reconnecting");
    expect(notifications.some((text) => text.includes("reload"))).toBe(false);
    await advanceTime(reconnectDelay(9));
    await animationFrame();
    expect(calls.reconnect).toBe(11);
    expect(agent.voip.status).toBe("connected");
    expect(calls.register).toBe(registers + 1);
});

test("unregisters on pagehide", async () => {
    const {calls} = setupAgent();
    await animationFrame();
    window.dispatchEvent(new Event("pagehide"));
    await animationFrame();
    expect(calls.unregister).toBe(1);
    expect(calls.stop).toBe(1);
});

test("does not log the password", async () => {
    const {agent, notifications, errors} = setupAgent({failCreation: true});
    await animationFrame();
    expect(agent.voip.status).toBe("disconnected");
    expect(errors.length).toBe(1);
    expect(notifications.length).toBe(1);
    expect(errors.join(" ")).not.toInclude(PASSWORD);
    expect(notifications.join(" ")).not.toInclude(PASSWORD);
});

test("re-registers on pageshow from bfcache", async () => {
    const {calls} = setupAgent();
    await animationFrame();
    const registers = calls.register;
    window.dispatchEvent(new Event("pagehide"));
    await animationFrame();
    window.dispatchEvent(new PageTransitionEvent("pageshow", {persisted: false}));
    await animationFrame();
    expect(calls.register).toBe(registers);
    window.dispatchEvent(new PageTransitionEvent("pageshow", {persisted: true}));
    await animationFrame();
    expect(calls.register).toBe(registers + 1);
});

test("register rejection is handled and the status is not green", async () => {
    const {agent, calls, errors} = setupAgent({registerStatus: 500});
    await animationFrame();
    expect(calls.register).toBe(1);
    expect(errors.length > 0).toBe(true);
    expect(agent.voip.status).not.toBe("connected");
});

test("stale agent is discarded on pageshow from bfcache", async () => {
    const {agent, agents, calls} = setupAgent({failReconnects: 1});
    await animationFrame();
    agents[0].transport.drop(new Error("connection lost"));
    await animationFrame();
    expect(agents[0].reconnects).toBe(1);
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", {persisted: true}));
    await animationFrame();
    expect(agents.length).toBe(2);
    expect(agents[0].stops >= 1).toBe(true);
    await advanceTime(60000);
    await animationFrame();
    expect(agents[0].reconnects).toBe(1);
    expect(agents[1].reconnects).toBe(0);
    expect(calls.start).toBe(2);
    expect(agent.voip.status).toBe("connected");
});

test("keeps retrying when start fails", async () => {
    const {agent, agents, calls} = setupAgent({failStarts: 2});
    await animationFrame();
    expect(agent.voip.status).toBe("reconnecting");
    await advanceTime(reconnectDelay(0));
    await animationFrame();
    await advanceTime(reconnectDelay(1));
    await animationFrame();
    expect(agents[0].isConnected()).toBe(true);
    expect(calls.register >= 1).toBe(true);
    expect(agent.voip.status).toBe("connected");
});

test("no timer is armed after stop", async () => {
    const {agent, agents, calls} = setupAgent({failReconnects: 100});
    await animationFrame();
    agents[0].transport.drop(new Error("connection lost"));
    agent.stop();
    await animationFrame();
    await advanceTime(60000);
    await animationFrame();
    expect(calls.reconnect <= 1).toBe(true);
    const after_stop = calls.reconnect;
    await advanceTime(60000);
    await animationFrame();
    expect(calls.reconnect).toBe(after_stop);
});

test("configures the keep alive interval", async () => {
    const {agents} = setupAgent();
    await animationFrame();
    expect(agents[0].options.transportOptions.keepAliveInterval).toBe(25);
});

test("refused renewal goes yellow and retries", async () => {
    const {agent, registerers, calls} = setupAgent();
    await animationFrame();
    expect(agent.voip.status).toBe("connected");
    registerers[0].expire();
    await animationFrame();
    expect(agent.voip.status).toBe("reconnecting");
    await advanceTime(reconnectDelay(0));
    await animationFrame();
    expect(calls.register).toBe(2);
    expect(agent.voip.status).toBe("connected");
});

test("REGISTER 503 retries", async () => {
    const {agent, net, calls} = setupAgent({registerStatus: 503});
    await animationFrame();
    expect(calls.register).toBe(1);
    expect(agent.voip.status).toBe("reconnecting");
    net.registerStatus = 200;
    await advanceTime(reconnectDelay(0));
    await animationFrame();
    expect(calls.register).toBe(2);
    expect(agent.voip.status).toBe("connected");
});

test("REGISTER 401 turns red, sticky notice and no retry", async () => {
    const {agent, calls, sticky} = setupAgent({registerStatus: 401});
    await animationFrame();
    expect(agent.voip.status).toBe("disconnected");
    expect(sticky.length).toBe(1);
    await advanceTime(120000);
    await animationFrame();
    expect(calls.register).toBe(1);
    expect(agent.voip.status).toBe("disconnected");
});

test("RequestPendingError retries", async () => {
    const {agent, agents, net, calls} = setupAgent({holdRegister: true});
    await animationFrame();
    expect(calls.register).toBe(1);
    agents[0].transport.drop(new Error("connection lost"));
    await animationFrame();
    // The first REGISTER is still pending: register() rejects
    expect(calls.register).toBe(2);
    net.holdRegister = false;
    net.held.shift()();
    await animationFrame();
    await advanceTime(reconnectDelay(0));
    await animationFrame();
    expect(agent.voip.status).toBe("connected");
});

test("two pageshow in a row leave a single active agent", async () => {
    const {agent, agents, calls} = setupAgent();
    await animationFrame();
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", {persisted: true}));
    window.dispatchEvent(new PageTransitionEvent("pageshow", {persisted: true}));
    await animationFrame();
    await animationFrame();
    const active = agents.filter((item) => item.state === "Started");
    expect(active.length).toBe(1);
    expect(agent.voip.status).toBe("connected");
    agents[agents.length - 1].transport.drop(new Error("connection lost"));
    await animationFrame();
    expect(calls.reconnect).toBe(1);
    expect(agent.voip.status).toBe("connected");
});

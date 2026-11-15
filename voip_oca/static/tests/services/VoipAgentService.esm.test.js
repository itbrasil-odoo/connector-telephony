/*
    Copyright 2025 Dixmit
    License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).
*/
import {VoipAgent, reconnectDelay} from "@voip_oca/services/voip_agent_service.esm";
import {advanceTime, after, animationFrame, expect, test} from "@odoo/hoot";
import {allowTranslations, patchWithCleanup} from "@web/../tests/web_test_helpers";

const PASSWORD = "s3cr3t-test-pw";

function setupAgent({
    failReconnects = 0,
    failStarts = 0,
    failCreation = false,
    rejectRegister = false,
    deferReconnect = false,
} = {}) {
    allowTranslations();
    const calls = {register: 0, unregister: 0, stop: 0, reconnect: 0, start: 0};
    const agents = [];
    const deferred = [];
    class FakeUserAgent {
        static makeURI(uri) {
            return uri;
        }
        constructor(options) {
            if (failCreation) {
                throw new Error(`bad config: ${JSON.stringify(options)}`);
            }
            this.options = options;
            this.stops = 0;
            this.reconnects = 0;
            agents.push(this);
        }
        async start() {
            calls.start++;
            if (calls.start <= failStarts) {
                throw new Error("network down");
            }
        }
        async stop() {
            calls.stop++;
            this.stops++;
        }
        reconnect() {
            calls.reconnect++;
            this.reconnects++;
            if (deferReconnect) {
                return new Promise((resolve, reject) =>
                    deferred.push({resolve, reject})
                );
            }
            if (calls.reconnect <= failReconnects) {
                return Promise.reject(new Error("network down"));
            }
            return Promise.resolve();
        }
    }
    class FakeRegisterer {
        listeners = [];
        stateChange = {addListener: (listener) => this.listeners.push(listener)};
        register() {
            calls.register++;
            if (rejectRegister) {
                return Promise.reject(new Error("RequestPendingError"));
            }
            for (const listener of this.listeners) {
                listener("Registered");
            }
            return Promise.resolve();
        }
        async unregister() {
            calls.unregister++;
        }
    }
    const previous = window.SIP;
    window.SIP = {
        UserAgent: FakeUserAgent,
        Registerer: FakeRegisterer,
        RegistererState: {Registered: "Registered"},
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
            notification: {add: (message) => notifications.push(String(message))},
            "mail.store": {},
        }
    );
    after(() => agent.stop());
    return {agent, agents, calls, deferred, notifications, errors};
}

test("reconnect delay grows and caps at 30s", () => {
    expect(reconnectDelay(0)).toBe(1000);
    expect(reconnectDelay(1)).toBe(2000);
    expect(reconnectDelay(5)).toBe(30000);
    expect(reconnectDelay(20)).toBe(30000);
});

test("reconnect never gives up", async () => {
    const {agent, calls, notifications} = setupAgent({failReconnects: 10});
    await animationFrame();
    expect(agent.voip.status).toBe("connected");
    const registers = calls.register;
    agent._onDisconnect(new Error("connection lost"));
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
    const {agent, calls, errors} = setupAgent({rejectRegister: true});
    await animationFrame();
    expect(calls.register).toBe(1);
    expect(errors.length).toBe(1);
    expect(agent.voip.status).toBe("connecting");
});

test("stale agent is discarded on pageshow from bfcache", async () => {
    const {agent, agents, calls} = setupAgent({failReconnects: 100});
    await animationFrame();
    agent._onDisconnect(new Error("connection lost"));
    await animationFrame();
    expect(agents[0].reconnects).toBe(1);
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", {persisted: true}));
    await animationFrame();
    expect(agents.length).toBe(2);
    expect(agents[0].stops >= 1).toBe(true);
    expect(agent.voip.status).toBe("connected");
    await advanceTime(60000);
    await animationFrame();
    expect(agents[0].reconnects).toBe(1);
    expect(agents[1].reconnects).toBe(0);
    expect(calls.start).toBe(2);
});

test("keeps retrying when start fails", async () => {
    const {agent, calls} = setupAgent({failStarts: 2});
    await animationFrame();
    expect(agent.voip.status).toBe("reconnecting");
    await advanceTime(reconnectDelay(0));
    await animationFrame();
    expect(calls.start).toBe(2);
    await advanceTime(reconnectDelay(1));
    await animationFrame();
    expect(calls.start).toBe(3);
    expect(agent.voip.status).toBe("connected");
});

test("no timer is armed after stop", async () => {
    const {agent, calls, deferred} = setupAgent({deferReconnect: true});
    await animationFrame();
    agent._onDisconnect(new Error("connection lost"));
    await animationFrame();
    expect(calls.reconnect).toBe(1);
    agent.stop();
    deferred[0].reject(new Error("network down"));
    await animationFrame();
    await advanceTime(60000);
    await animationFrame();
    expect(calls.reconnect).toBe(1);
});

test("configures the keep alive interval", async () => {
    const {agents} = setupAgent();
    await animationFrame();
    expect(agents[0].options.transportOptions.keepAliveInterval).toBe(25);
});

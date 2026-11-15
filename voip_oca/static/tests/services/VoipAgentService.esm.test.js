/*
    Copyright 2025 Dixmit
    License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).
*/
import {VoipAgent, reconnectDelay} from "@voip_oca/services/voip_agent_service.esm";
import {advanceTime, after, animationFrame, expect, test} from "@odoo/hoot";
import {allowTranslations, patchWithCleanup} from "@web/../tests/web_test_helpers";

const PASSWORD = "s3cr3t-test-pw";

function setupAgent({failReconnects = 0, failCreation = false} = {}) {
    allowTranslations();
    const calls = {register: 0, unregister: 0, stop: 0, reconnect: 0};
    class FakeUserAgent {
        static makeURI(uri) {
            return uri;
        }
        constructor(options) {
            if (failCreation) {
                throw new Error(`bad config: ${JSON.stringify(options)}`);
            }
        }
        async start() {
            return true;
        }
        async stop() {
            calls.stop++;
        }
        async reconnect() {
            calls.reconnect++;
            if (calls.reconnect <= failReconnects) {
                throw new Error("network down");
            }
        }
    }
    class FakeRegisterer {
        stateChange = {addListener: () => true};
        register() {
            calls.register++;
        }
        async unregister() {
            calls.unregister++;
        }
    }
    const previous = window.SIP;
    window.SIP = {
        UserAgent: FakeUserAgent,
        Registerer: FakeRegisterer,
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
    return {agent, calls, notifications, errors};
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

/* global SIP */
/*
    Copyright 2025 Dixmit
    License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).
    This service will contain all the logic necessary for the integration
    with the SIP.
*/
import {_t} from "@web/core/l10n/translation";
import {loadBundle} from "@web/core/assets";
import {proxy} from "@odoo/owl";
import {registry} from "@web/core/registry";

/*
    Delay (ms) to wait after the failed reconnection attempt number `attempt`
    (starting at 0): 1s, 2s, 4s... capped at 30s.
*/
export function reconnectDelay(attempt) {
    return Math.min(1000 * 2 ** Math.max(attempt, 0), 30000);
}

export class VoipAgent {
    constructor(env, services) {
        this.toneAudio = new window.Audio();
        this.callAudio = new window.Audio();
        this.voip = services.voip_oca;
        this.multiTab = services.multi_tab;
        this.orm = services.orm;
        this.notification = services.notification;
        this.session = false;
        this.isMuted = false;
        this.isHolded = false;
        this.reconnectTimer = null;
        this.generation = 0;
        this.stopped = false;
        this.resetRegistration();
        this._onPageHide = this.onPageHide.bind(this);
        this._onPageShow = this.onPageShow.bind(this);
        this.store = services["mail.store"];
        this.connectAgent();
        return proxy(this);
    }
    get hasRtcSupport() {
        return Boolean(
            navigator.mediaDevices &&
            navigator.mediaDevices.getUserMedia &&
            window.MediaStream
        );
    }
    get agentConfig() {
        return this.buildAgentConfig(this.generation);
    }
    buildAgentConfig(generation) {
        return {
            authorizationPassword: this.voip.pbx_password,
            authorizationUsername: this.voip.pbx_username,
            delegate: {
                onCallHangup: () => {
                    this.voip.inCall = false;
                },
                onInvite: this.onInvite.bind(this),
                onDisconnect: (error) => this._onDisconnect(error, generation),
            },
            logBuiltinEnabled: odoo.debug !== "",
            logLevel: odoo.debug === "" ? "error" : "debug",
            transportOptions: {
                server: this.voip.pbx_ws,
                // Keep-alive helps TCP/NAT keep the socket open. SIP.js 0.21.2 does
                // not close half-open sockets by itself (sip.js:11271-11287).
                keepAliveInterval: 25,
            },
            uri: SIP.UserAgent.makeURI(
                `sip:${this.voip.pbx_username}@${this.voip.pbx_domain}`
            ),
            userAgentString: `OCA SIP.js/${window.SIP.version}`,
        };
    }
    /* Removes the password from any text that could be logged or shown */
    redact(text) {
        const password = this.voip.pbx_password;
        const value = String(text ?? "");
        return password ? value.split(password).join("***") : value;
    }
    async loadSipLibrary() {
        await loadBundle("voip_oca.agent_assets");
    }
    /* State of the registration cycle of the current agent */
    resetRegistration() {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.ensuring = false;
        this.startCalled = false;
        this.authRejected = false;
        this.attempt = 0;
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
        this.immediateUsed = false;
        this.reported = false;
    }
    async connectAgent() {
        if (this.voip.mode !== "prod") {
            console.info("Voip agent is not available in non-production mode");
            return;
        }
        // Every await below is followed by a check of this generation
        const generation = ++this.generation;
        this.resetRegistration();
        this.voip.status = "connecting";
        if (!this.hasRtcSupport) {
            console.info("Voip agent is not available in this browser");
            return;
        }
        if (!this.voip.pbx_ws || !this.voip.pbx_username || !this.voip.pbx_password) {
            console.info("Some PBX information is missing. Check your configuration");
            return;
        }
        /*
            We want to avoid errors on the navigator.
            We will only load the libraries if needed
        */
        try {
            await this.loadSipLibrary();
        } catch (error) {
            if (this._isStale(generation)) {
                return;
            }
            const message = this.redact(error.message);
            console.error(message);
            this.notification.add(
                _t("Failed to load the SIP.js library:\n\n%(error)s", {
                    error: message,
                })
            );
            return;
        }
        if (this._isStale(generation)) {
            return;
        }
        let agent = null;
        try {
            agent = new SIP.UserAgent(this.buildAgentConfig(generation));
        } catch (error) {
            const message = this.redact(error.message);
            console.error(message);
            this.voip.status = "disconnected";
            this.notification.add(
                _t(
                    "An error occurred during the instantiation of the User Agent:\n\n%(error)s",
                    {
                        error: message,
                    }
                )
            );
            return;
        }
        this.agent = agent;
        this.registerer = new SIP.Registerer(agent);
        this.registerer.stateChange.addListener((state) =>
            this._onRegistererStateChange(state, generation)
        );
        // Same function references: adding them again never duplicates them
        window.addEventListener("pagehide", this._onPageHide);
        window.addEventListener("pageshow", this._onPageShow);
        await this.ensureRegistered(generation);
    }
    _isStale(generation) {
        return this.stopped || generation !== this.generation;
    }
    /*
        The only place that (re)establishes the line. It looks at the REAL state:
        reconnects the transport if it is down (start() only if the agent never
        started: a second start() does not connect), then sends a REGISTER.
        Any failure schedules a new attempt, so it never gives up.
    */
    async ensureRegistered(generation) {
        if (this._isStale(generation) || this.ensuring || this.authRejected) {
            return;
        }
        const agent = this.agent;
        const registerer = this.registerer;
        if (
            agent.isConnected() &&
            registerer.state === SIP.RegistererState.Registered
        ) {
            return;
        }
        this.ensuring = true;
        try {
            if (!agent.isConnected()) {
                if (this.startCalled) {
                    await agent.reconnect();
                } else {
                    this.startCalled = true;
                    await agent.start();
                }
                if (this._isStale(generation)) {
                    return;
                }
            }
            // Rejects with RequestPendingError if a REGISTER is still pending
            await registerer.register({
                requestDelegate: {
                    onAccept: () => this._onRegistered(generation),
                    onReject: (response) =>
                        this._onRegistererRejected(response, generation),
                },
            });
        } catch (error) {
            if (this._isStale(generation)) {
                return;
            }
            this._report(this.redact(error?.message));
            this._scheduleRetry(generation);
        } finally {
            if (generation === this.generation) {
                this.ensuring = false;
            }
        }
    }
    _scheduleRetry(generation) {
        if (this._isStale(generation) || this.authRejected || this.reconnectTimer) {
            return;
        }
        this.voip.status = "reconnecting";
        this.reconnectTimer = setTimeout(
            () => {
                this.reconnectTimer = null;
                this.ensureRegistered(generation);
            },
            Math.max(reconnectDelay(this.attempt++), this._retryAfterMs())
        );
    }
    /* Seconds asked by the PBX in a 500/503 "Retry-After" (sip.js:7584-7591) */
    _retryAfterMs() {
        return (this.registerer?.retryAfter || 0) * 1000;
    }
    /* Logs once per drop cycle, not on every attempt */
    _report(message) {
        if (!this.reported) {
            this.reported = true;
            console.error(message);
        }
    }
    _onRegistered(generation) {
        if (this._isStale(generation)) {
            return;
        }
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.voip.status = "connected";
        // The attempts only start over when the registration holds for 30 s,
        // so a server that accepts and drops the socket stays throttled.
        clearTimeout(this.stableTimer);
        this.stableTimer = setTimeout(() => {
            this.stableTimer = null;
            this.attempt = 0;
            this.immediateUsed = false;
            this.reported = false;
        }, 30000);
    }
    /* Releases the registration when the page is closed (fire and forget) */
    onPageHide() {
        const {agent, registerer} = this;
        // The old agent must not react to anything from now on
        this.generation++;
        this.resetRegistration();
        this._ignoreResult(() => registerer?.unregister());
        this._ignoreResult(() => agent?.stop());
    }
    /* The page came back from the back-forward cache: the agent was stopped */
    onPageShow(event) {
        if (!event.persisted || this.stopped) {
            return;
        }
        // Discard everything that belongs to the old agent
        const oldAgent = this.agent;
        this.generation++;
        this.resetRegistration();
        this.session = false;
        this.voip.inCall = false;
        this.stopTone();
        this.callAudio.srcObject = null;
        this.callAudio.pause();
        this._ignoreResult(() => oldAgent?.stop());
        this.connectAgent();
    }
    _ignoreResult(action) {
        try {
            Promise.resolve(action()).catch((error) =>
                console.error(this.redact(error?.message))
            );
        } catch {
            // Nothing to do: the page is going away.
        }
    }
    stop() {
        this.stopped = true;
        window.removeEventListener("pagehide", this._onPageHide);
        window.removeEventListener("pageshow", this._onPageShow);
        this.resetRegistration();
    }
    playTone(tone) {
        this.toneAudio.currentTime = 0;
        this.toneAudio.loop = true;
        this.toneAudio.src = this.voip.tones[tone];
        this.toneAudio.play();
    }
    stopTone() {
        this.toneAudio.pause();
    }
    /* On call actions */
    async onInvite(session) {
        if (this.session) {
            // We are busy here
            session.reject({statusCode: 486});
        }
        await this.createCall({
            phone_number: session.remoteIdentity.uri.user,
            type_call: "incoming",
            state: "calling",
        });
        this.voip.inCall = true;
        this.voip.isOpened = true;
        this.voip.isFolded = false;
        session.stateChange.addListener(this._onSessionStateChange.bind(this));
        /* TODO: Modify the VOIP Widget */
        if (this.multiTab.isOnMainTab()) {
            // We will only play the calltone if we are on the main tab
            this.playTone("calltone");
            // TODO; Maybe we could send a notification???
        }
        session.delegate = {
            onBye: this._onHanghup.bind(this),
            onCancel: this._onCancelInvitation.bind(this),
        };
        this.session = session;
        this.isMuted = false;
        this.isHolded = false;
    }
    _onDisconnect(error, generation = this.generation) {
        // Fired only when the transport leaves "Connected"
        if (this._isStale(generation) || this.authRejected) {
            return;
        }
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
        if (error && !this.reported) {
            this.reported = true;
            const message = this.redact(error.message);
            console.error(message);
            this.notification.add(
                _t("An error occurred during the connection:\n\n%(error)s", {
                    error: message,
                })
            );
        }
        this.voip.status = "reconnecting";
        if (this.immediateUsed) {
            this._scheduleRetry(generation);
        } else {
            // Only the first drop of a stable registration retries at once
            this.immediateUsed = true;
            this.ensureRegistered(generation);
        }
    }
    _onSessionStateChange(newState) {
        switch (newState) {
            case SIP.SessionState.Initial:
            case SIP.SessionState.Terminating:
            case SIP.SessionState.Establishing:
                break;
            case SIP.SessionState.Terminated:
                // We need to stop the tone if it was not established
                this.stopTone();
                break;
            case SIP.SessionState.Established:
                this.stopTone();
                this.setCallAudio();
                this.session.sessionDescriptionHandler.remoteMediaStream.onaddtrack =
                    this.setCallAudio.bind(this);
                break;
            default:
                throw new Error(`Unknown session state: "${newState}".`);
        }
    }
    setCallAudio() {
        /* We need to set the call audio of the session */
        const stream = new MediaStream();
        for (const receiver of this.session.sessionDescriptionHandler.peerConnection.getReceivers()) {
            if (receiver.track) {
                stream.addTrack(receiver.track);
            }
        }
        this.callAudio.srcObject = stream;
        this.callAudio.play();
    }
    updateCallAudio() {
        if (this.session?.sessionDescriptionHandler) {
            this.session.sessionDescriptionHandler.enableReceiverTracks(!this.isHolded);
            this.session.sessionDescriptionHandler.enableSenderTracks(
                !this.isHolded && !this.isMuted
            );
        }
    }
    async createCall(options) {
        const call = await this.orm.call("voip.call", "create_call", [
            {
                pbx_id: this.voip.pbx_id,
                ...options,
            },
        ]);

        this.voip.call = this.store["voip.call"].insert(call);
        if (call.partner) {
            this.voip.partner = this.store["res.partner"].insert({...call.partner});
        }
    }
    async call({number, partner}) {
        this.voip.isOpened = true;
        this.voip.isFolded = false;
        var phone_number = number;
        if (!number && partner) {
            phone_number = partner.phone;
        }
        this.playTone("dialtone");
        await this.createCall({
            partner_id: partner && partner.id,
            phone_number: phone_number,
            type_call: "outgoing",
            state: "calling",
        });
        this.voip.inCall = true;
        if (this.voip.mode === "prod") {
            const destination_number = SIP.UserAgent.makeURI(
                `sip:${phone_number.replace(/\D/g, "")}@${this.voip.pbx_domain}`
            );
            this.session = new SIP.Inviter(this.agent, destination_number);
            this.session.delegate = {
                onBye: this._onHanghup.bind(this),
            };
            this.isMuted = false;
            this.isHolded = false;
            this.session.stateChange.addListener(this._onSessionStateChange.bind(this));
            this.session
                .invite({
                    requestDelegate: {
                        onAccept: this._onInviteAccepted.bind(this),
                        onReject: this._onInviteRejected.bind(this),
                    },
                })
                .catch((error) => {
                    // This might happen, for example, if we close the call too early.
                    this.notification.add(
                        _t("Failed to establish the call:\n\n%(error)s", {
                            error: error.message,
                        })
                    );
                });
        }
    }
    transfer(number) {
        if (this.voip.mode !== "prod") {
            this._onHanghup();
            return;
        }
        this.session.refer(
            SIP.UserAgent.makeURI(`sip:${number}@${this.voip.pbx_domain}`),
            {
                requestDelegate: {
                    onAccept: this._onTransferAccepted.bind(this),
                },
            }
        );
    }
    _onTransferAccepted() {
        this.session.bye();
        this._onHanghup();
    }
    _onInviteAccepted() {
        if (!this.session) {
            return;
        }
        this.stopTone();
        this.voip.acceptCall();
    }
    _onInviteRejected(response) {
        if (!this.session) {
            return;
        }
        this.stopTone();
        this.notification.add(
            _t("Call rejected. Reason:\n\n%(reason)s", {
                reason: response.message.reasonPhrase,
            })
        );
        this.voip.rejectCall();
        this.session = null;
    }
    async _onCancelInvitation() {
        this.stopTone();
        this.voip.rejectCall();
        this.session = null;
    }
    async _onHanghup() {
        this.stopTone();
        this.callAudio.srcObject = null;
        this.callAudio.pause();
        this.voip.call.update(
            await this.orm.call("voip.call", "terminate_call", [[this.voip.call.id]])
        );
        this.voip.inCall = false;
        this.session = false;
    }
    async hangup() {
        if (this.session) {
            switch (this.session.state) {
                case SIP.SessionState.Initial:
                    if (this.voip.call.typeCall === "outgoing") {
                        this.session.cancel();
                    } else {
                        this.session.reject();
                    }
                    break;
                case SIP.SessionState.Establishing:
                    this.session.cancel();
                    break;
                case SIP.SessionState.Established:
                    this.session.bye();
                    break;
            }
        }
        this._onHanghup();
    }
    async mute() {
        this.isMuted = !this.isMuted;
        this.updateCallAudio();
    }
    async hold() {
        this.isHolded = !this.isHolded;
        try {
            await this.session.invite({
                requestDelegate: {
                    onReject() {
                        this.isHolded = !this.isHolded;
                    },
                },
                sessionDescriptionHandlerOptions: {hold: this.isHolded},
            });
        } catch (error) {
            console.error(error);
            this.notification.add(
                _t("Failed to put the call on hold/unhold:\n\n%(error)s", {
                    error: error.message.reasonPhrase,
                })
            );
        }
        this.updateCallAudio();
    }
    async accept() {
        if (this.session) {
            this.session.accept();
        }
        this.voip.acceptCall();
    }
    /* Registerer functions */
    _onRegistererRejected(response, generation) {
        if (this._isStale(generation)) {
            return;
        }
        const status = response?.message?.statusCode;
        if (status === 401 || status === 403) {
            // Wrong extension or password: retrying would only lock the account
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
            this.authRejected = true;
            this.voip.status = "disconnected";
            this.notification.add(
                _t(
                    "Extension or password refused by the PBX. Contact the administrator."
                ),
                {sticky: true, type: "danger"}
            );
            return;
        }
        // 408, 5xx (including the internal 503 of a dead transport), others
        this._report(`REGISTER rejected with status ${status}`);
        this._scheduleRetry(generation);
    }
    _onRegistererStateChange(state, generation) {
        if (this._isStale(generation)) {
            return;
        }
        this.registererState = state;
        if (state === SIP.RegistererState.Registered) {
            this._onRegistered(generation);
        } else if (state === SIP.RegistererState.Unregistered) {
            // Lost registration (refused renewal, expiry, rejection). A 401/403
            // arrives right after this and cancels the retry.
            clearTimeout(this.stableTimer);
            this.stableTimer = null;
            this.voip.status = "reconnecting";
            this._scheduleRetry(generation);
        }
    }
}

export const voipAgentOCAService = {
    dependencies: ["voip_oca", "multi_tab", "notification", "orm", "mail.store"],
    async start() {
        return new VoipAgent(...arguments);
    },
};

registry.category("services").add("voip_agent_oca", voipAgentOCAService);

// Copy the documented extension unchanged: its GUI writes private settings and its actual tool uses them.
import {
    cleanUp,
    fakeTab,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";

const token = "NOTIFIER_TOKEN_PRIVATE_SENTINEL";
const endpointSecret = "NOTIFIER_ENDPOINT_PRIVATE_SENTINEL";
const modelRequests: string[] = [];
const responses: string[] = [];
const deliveries: { url: string; authorization: string; body: unknown }[] = [];
const browserPaths: string[] = [];
let app: App;
let server: Server;
let receiver: Server;
let base = "";
let endpoint = "";
let deliveryStatus = 202;
let tabs: ReturnType<typeof fakeTab>[] = [];

before(async () => {
    app = await openApp(
        scriptedModel((request) => {
            modelRequests.push(JSON.stringify(request));
            const { role, text } = lastText(request as never);

            return role === "toolResult"
                ? fauxAssistantMessage([fauxText(text)])
                : fauxAssistantMessage([fauxToolCall("send_notification", { message: text })], {
                      stopReason: "toolUse",
                  });
        }),
    );
    cpSync(
        new URL("../docs/examples/custom-notifier/", import.meta.url),
        join(app.dataDir, "extensions", "custom-notifier"),
        { recursive: true },
    );
    await app.setExtensionEnabled(owner(app), "custom-notifier", true);
    tabs = [
        fakeTab(undefined, owner(app)),
        fakeTab(undefined, app.config.addUser("Peer", "guest").user),
    ];

    for (const tab of tabs) {
        await app.attach(tab.client);
    }

    receiver = createServer(async (request, response) => {
        const chunks: Buffer[] = [];

        for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
        }

        deliveries.push({
            url: request.url ?? "",
            authorization: request.headers.authorization ?? "",
            body: JSON.parse(Buffer.concat(chunks).toString()),
        });

        if (deliveryStatus === 307) {
            response.setHeader("location", request.url ?? "/notify");
        }

        response.writeHead(deliveryStatus);
        response.end(`${token}:${endpointSecret}`);
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const address = receiver.address();

    assert.ok(address && typeof address !== "string");
    endpoint = `http://127.0.0.1:${address.port}/notify?destination=${endpointSecret}`;
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("request", (request) => browserPaths.push(request.url ?? ""));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const publicAddress = server.address();

    assert.ok(publicAddress && typeof publicAddress !== "string");
    base = `http://127.0.0.1:${publicAddress.port}`;
});

after(async () => {
    for (const each of [server, receiver]) {
        each?.closeAllConnections();
        await new Promise<void>((resolve) => each?.close(() => resolve()) ?? resolve());
    }

    for (const tab of tabs) {
        app.detach(tab.client);
    }

    await app?.close();
    cleanUp();
});

async function rpc(action: string, payload: unknown = {}) {
    const sheet = app.loader.sheets().find((each) => each.moduleId === "custom-notifier");

    assert.ok(sheet);
    const response = await fetch(`${base}/api/extensions/custom-notifier/rpc`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "content-type": "application/json",
            "x-pocket": "1",
        },
        body: JSON.stringify({ generation: sheet.generation, action, payload }),
    });
    const text = await response.text();

    responses.push(text);
    assert.equal(response.status, 200, text);
    const answer = JSON.parse(text);

    assert.equal(answer.ok, true);

    return answer.data;
}

function privateSettings() {
    return JSON.parse(readFileSync(join(app.dataDir, "custom-notifier", "config.json"), "utf8"));
}

/** Inspect committed JSON, including document history and the records that hold task memos. */
function assertNoDurableSecrets(): { tasks: number; entries: number } {
    const database = new DatabaseSync(join(app.dataDir, "pocket.sqlite"), { readOnly: true });
    const counts: Record<string, number> = {};

    try {
        for (const table of [
            "conversations",
            "entries",
            "tasks",
            "submissions",
            "documents",
            "document_revisions",
        ]) {
            const column = table === "document_revisions" ? "content" : "record";
            const rows = database.prepare(`SELECT ${column} AS value FROM ${table}`).all();

            counts[table] = rows.length;

            for (const row of rows) {
                assert.equal(typeof row.value, "string");
                const value = JSON.stringify(JSON.parse(row.value as string));

                assert.equal(value.includes(token), false, `${table} contains a private token`);
                assert.equal(
                    value.includes(endpointSecret),
                    false,
                    `${table} contains a private endpoint`,
                );
            }
        }
    } finally {
        database.close();
    }

    return { tasks: counts.tasks!, entries: counts.entries! };
}

test("the documented native GUI saves write-only credentials without a model request", async () => {
    assert.deepEqual(await rpc("get_state"), {
        version: 0,
        label: "Pi Pocket",
        hasEndpoint: false,
        hasToken: false,
    });
    const saved = await rpc("save", { version: 0, label: "Build alerts", endpoint, token });

    assert.deepEqual(saved, {
        saved: true,
        state: { version: 1, label: "Build alerts", hasEndpoint: true, hasToken: true },
    });
    assert.equal(privateSettings().token, token);
    assert.equal(privateSettings().endpoint, endpoint);
    assert.equal(modelRequests.length, 0);
    assert.deepEqual(app.sessions(owner(app)), []);
    assertNoDurableSecrets();
});

test("ordinary edits preserve credentials and concurrent stale saves cannot overwrite the winner", async () => {
    const initial = await rpc("get_state");
    const first = await rpc("save", { version: initial.version, label: "Renamed" });

    assert.equal(first.saved, true);
    assert.equal(privateSettings().token, token);
    assert.equal(privateSettings().endpoint, endpoint);
    const results = await Promise.all([
        rpc("save", { version: first.state.version, label: "First tab" }),
        rpc("save", { version: first.state.version, label: "Second tab" }),
    ]);

    assert.equal(results.filter((result) => result.saved).length, 1);
    assert.equal(results.filter((result) => !result.saved).length, 1);
    assert.equal(privateSettings().token, token);
    assert.equal(privateSettings().endpoint, endpoint);
    assert.equal(privateSettings().label, results.find((result) => result.saved).state.label);
});

test("replacing, preserving, and explicitly clearing each credential are distinct operations", async () => {
    let state = await rpc("get_state");
    const replacement = `${token}_REPLACED`;
    let result = await rpc("save", {
        version: state.version,
        label: "Replacement",
        token: replacement,
    });

    assert.equal(result.saved, true);
    assert.equal(privateSettings().token, replacement);
    assert.equal(privateSettings().endpoint, endpoint);
    result = await rpc("save", {
        version: result.state.version,
        label: "Cleared token",
        token: null,
    });
    assert.equal(result.saved, true);
    assert.equal(result.state.hasToken, false);
    assert.equal(result.state.hasEndpoint, true);
    assert.equal(privateSettings().token, undefined);
    result = await rpc("save", {
        version: result.state.version,
        label: "Cleared endpoint",
        endpoint: null,
    });
    assert.equal(result.state.hasEndpoint, false);
    assert.equal(privateSettings().endpoint, undefined);
    state = await rpc("get_state");
    await rpc("save", { version: state.version, label: "Build alerts", endpoint, token });
});

test("invalid input does not overwrite the existing settings or echo private values", async () => {
    const original = privateSettings();

    for (const patch of [
        { endpoint: `file:///${endpointSecret}` },
        { token: "" },
        { label: "" },
        { token: 123 },
    ]) {
        const result = await rpc("save", { version: original.version, label: "Attempt", ...patch });

        assert.equal(result.saved, false);
        assert.deepEqual(privateSettings(), original);
    }
});

test("the real notification tool uses GUI settings but neither credentials nor receiver responses enter model context", async () => {
    const id = await newSession(app);

    await say(app, id, "Build completed");
    assert.deepEqual(deliveries.at(-1), {
        url: `/notify?destination=${endpointSecret}`,
        authorization: `Bearer ${token}`,
        body: { label: "Build alerts", message: "[from: Owner] Build completed" },
    });
    assert.match((await modelTexts(app, id)).at(-1) ?? "", /Notification sent/);
    deliveryStatus = 503;
    await say(app, id, "Delivery may fail");
    deliveryStatus = 202;
    assert.match((await modelTexts(app, id)).at(-1) ?? "", /could not be confirmed/);
    const request = JSON.parse(modelRequests.at(-1)!) as {
        messages: { role: string; isError?: boolean }[];
    };

    assert.equal(
        request.messages.findLast((message) => message.role === "toolResult")?.isError,
        true,
    );

    for (const secret of [token, endpointSecret]) {
        assert.equal(
            modelRequests.some((request) => request.includes(secret)),
            false,
        );
        assert.equal(
            responses.some((response) => response.includes(secret)),
            false,
        );
        assert.equal(JSON.stringify(tabs.flatMap((tab) => tab.events)).includes(secret), false);
    }
});

test("a receiver redirect cannot automatically repeat the notification POST", async () => {
    const id = await newSession(app);
    const before = deliveries.length;

    deliveryStatus = 307;

    try {
        await say(app, id, "Do not redirect this delivery");
    } finally {
        deliveryStatus = 202;
    }

    assert.equal(deliveries.length - before, 1);
    const request = JSON.parse(modelRequests.at(-1)!) as {
        messages: { role: string; isError?: boolean }[];
    };

    assert.equal(
        request.messages.findLast((message) => message.role === "toolResult")?.isError,
        true,
    );
});

async function openNotifier(page: BrowserPage): Promise<void> {
    await page.evaluate(
        'const { openSheet } = await import("/store.js"); openSheet({ type: "extensions" });',
    );
    await until(
        async () =>
            JSON.parse(
                await page.evaluate(
                    'return JSON.stringify(!![...document.querySelectorAll(".extension")].find((row) => row.querySelector(".extension-title").textContent.trim() === "custom-notifier"));',
                ),
            ),
        "the documented module",
    );
    await page.evaluate(`
        const row = [...document.querySelectorAll(".extension")].find((row) => row.querySelector(".extension-title").textContent.trim() === "custom-notifier");
        [...row.querySelectorAll("button")].find((button) => button.textContent.trim() === "Open").click();
    `);
    await until(
        async () =>
            JSON.parse(
                await page.evaluate(
                    'return JSON.stringify(!!document.querySelector("#notifier-label"));',
                ),
            ),
        "the documented component",
    );
}

async function checkLayout(page: BrowserPage): Promise<void> {
    const directory = process.env.PI_POCKET_GUI_EVIDENCE;

    if (directory) {
        mkdirSync(directory, { recursive: true });
    }

    for (const [name, viewport] of [
        ["mobile", VIEWPORTS.mobile],
        ["desktop", VIEWPORTS.desktop],
    ] as const) {
        await page.setViewport(viewport);
        await until(
            async () =>
                JSON.parse(
                    await page.evaluate(`
            return JSON.stringify(!document.getAnimations().some((animation) =>
                animation.playState === "running" && animation.effect?.target.closest(".sheet-host")));
        `),
                ),
            "settled notifier layout",
        );
        const layout = JSON.parse(
            await page.evaluate(`
            const sheet = document.querySelector(".sheet");
            const bounds = (element) => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
            };
            return JSON.stringify({
                width: innerWidth, height: innerHeight,
                documentWidth: document.documentElement.scrollWidth,
                sheets: document.querySelectorAll(".sheet").length,
                sheet: bounds(sheet),
                checkboxes: [...sheet.querySelectorAll('input[type="checkbox"]')]
                    .map((element) => ({ id: element.id, ...bounds(element) })),
                controls: [...sheet.querySelectorAll('input:not([type="checkbox"]), .actions button, label.list-item')]
                    .map((element) => ({ id: element.id || element.textContent.trim(), ...bounds(element) })),
            });
        `),
        );

        if (directory) {
            const shot = await page.screenshot();

            writeFileSync(
                join(directory, `notifier-${name}.jpg`),
                Buffer.from(shot.data, "base64"),
            );
            writeFileSync(
                join(directory, `notifier-${name}.json`),
                JSON.stringify({ ...layout, imageScale: shot.scale }, null, 2),
            );
        }

        for (const checkbox of layout.checkboxes) {
            assert.ok(
                checkbox.width <= checkbox.height,
                `${checkbox.id} stretches across its label`,
            );
        }

        assert.equal(layout.sheets, 1, "the plugin supplies content, not another Sheet");
        assert.ok(layout.documentWidth <= layout.width && layout.sheet.width <= layout.width);

        for (const control of layout.controls) {
            assert.ok(
                control.left >= 0 && control.right <= layout.width,
                `${control.id} overflows`,
            );

            if (name === "mobile") {
                assert.ok(
                    control.height >= 38,
                    `${control.id} needs a touch target near 40px, got ${control.height}`,
                );
            }
        }
    }

    await page.setViewport(VIEWPORTS.mobile);
}

test(
    "the unchanged example works from the mobile GUI through private storage to the real tool",
    { skip: findBrowser() === undefined },
    async () => {
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "pocket-notifier-browser-")),
            load: async () => undefined,
            save: () => {},
        });
        const before = modelRequests.length;
        let page: BrowserPage;

        try {
            page = await browsers.open(1);
            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await until(
                async () =>
                    JSON.parse(
                        await page.evaluate(
                            'const { store } = await import("/store.js"); return JSON.stringify(store.state.me?.role === "owner");',
                        ),
                    ),
                "the owner UI",
                20_000,
            );
            await openNotifier(page);
            const fields = JSON.parse(
                await page.evaluate(`
            return JSON.stringify({ endpoint: document.querySelector("#notifier-endpoint").value,
                token: document.querySelector("#notifier-token").value,
                text: document.querySelector(".sheet").textContent,
                overflow: document.documentElement.scrollWidth > innerWidth });
        `),
            );

            assert.equal(fields.endpoint, "");
            assert.equal(fields.token, "");
            assert.equal(fields.text.includes(token), false);
            assert.equal(fields.text.includes(endpointSecret), false);
            assert.equal(fields.overflow, false);
            await page.evaluate(`
            const field = document.querySelector("#notifier-label");
            field.value = "From the native GUI";
            field.dispatchEvent(new Event("input", { bubbles: true }));
        `);
            await page.evaluate('document.querySelector("#notifier-save").click();');
            await until(
                () => privateSettings().label === "From the native GUI",
                "the real GUI save",
            );
            assert.equal(privateSettings().token, token);
            assert.equal(privateSettings().endpoint, endpoint);
            assert.equal(modelRequests.length, before);
            await until(
                async () =>
                    JSON.parse(
                        await page.evaluate(
                            'return JSON.stringify(!document.querySelector("#notifier-save").disabled);',
                        ),
                    ),
                "the first save settles",
            );
            const guiToken = `${token}_GUI`;
            const guiEndpoint = `${endpoint}&source=gui`;

            await page.evaluate(`
            for (const [id, value] of [["notifier-endpoint", ${JSON.stringify(guiEndpoint)}], ["notifier-token", ${JSON.stringify(guiToken)}]]) {
                const input = document.getElementById(id);
                input.value = value;
                input.dispatchEvent(new Event("input", { bubbles: true }));
            }
        `);
            await page.evaluate('document.querySelector("#notifier-save").click();');
            await until(
                () => privateSettings().token === guiToken,
                "credentials saved by the actual GUI",
            );
            await until(
                async () =>
                    JSON.parse(
                        await page.evaluate(
                            'return JSON.stringify(!document.querySelector("#notifier-save").disabled && document.querySelector("#notifier-token").value === "");',
                        ),
                    ),
                "the saved secret leaves component state",
            );
            assert.equal(privateSettings().endpoint, guiEndpoint);
            assert.equal(modelRequests.length, before);
            await page.press("Escape");
            await openNotifier(page);
            assert.equal(
                await page.evaluate('return document.querySelector("#notifier-token").value;'),
                "",
            );
            assert.equal(
                await page.evaluate('return document.querySelector("#notifier-endpoint").value;'),
                "",
            );
            await checkLayout(page);
            const id = await newSession(app);

            await say(app, id, "GUI configured notification");
            assert.deepEqual(deliveries.at(-1), {
                url: `/notify?destination=${endpointSecret}&source=gui`,
                authorization: `Bearer ${guiToken}`,
                body: {
                    label: "From the native GUI",
                    message: "[from: Owner] GUI configured notification",
                },
            });
            await page.evaluate('document.querySelector("#notifier-clear-token").click();');
            await page.evaluate('document.querySelector("#notifier-save").click();');
            await until(
                () => privateSettings().token === undefined,
                "the GUI explicitly clears a token",
            );
            assert.equal(privateSettings().endpoint, guiEndpoint);
            assertNoDurableSecrets();

            for (const secret of [token, endpointSecret]) {
                assert.equal(
                    modelRequests.some((request) => request.includes(secret)),
                    false,
                );
                assert.equal(
                    browserPaths.some((path) => path.includes(secret)),
                    false,
                );
                assert.equal(
                    JSON.stringify(tabs.flatMap((tab) => tab.events)).includes(secret),
                    false,
                );
                assert.equal(
                    page.logs().some((log) => log.text.includes(secret)),
                    false,
                );
                assert.equal(
                    (
                        await page.evaluate(
                            "return JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } });",
                        )
                    ).includes(secret),
                    false,
                );
            }
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);

test("an unconfigured notifier reports a tool error without attempting delivery", async () => {
    const state = await rpc("get_state");

    await rpc("save", { version: state.version, label: state.label, token: null });
    const before = deliveries.length;
    const id = await newSession(app);

    await say(app, id, "Send without a token");
    assert.equal(deliveries.length, before);
    assert.match((await modelTexts(app, id)).at(-1) ?? "", /Configure the Custom notifier/);
    const request = JSON.parse(modelRequests.at(-1)!) as {
        messages: { role: string; isError?: boolean }[];
    };

    assert.equal(
        request.messages.findLast((message) => message.role === "toolResult")?.isError,
        true,
    );
});

test("malformed private storage does not expose its bytes through RPC errors, logs, or tool results", async (t) => {
    const file = join(app.dataDir, "custom-notifier", "config.json");
    const original = readFileSync(file, "utf8");
    const logged: unknown[] = [];

    t.mock.method(console, "error", (...args: unknown[]) => logged.push(...args));
    writeFileSync(file, token + endpointSecret);

    try {
        const sheet = app.loader.sheets().find((each) => each.moduleId === "custom-notifier")!;
        const response = await fetch(`${base}/api/extensions/custom-notifier/rpc`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "content-type": "application/json",
                "x-pocket": "1",
            },
            body: JSON.stringify({ generation: sheet.generation, action: "get_state" }),
        });

        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "extension_error" });
        const id = await newSession(app);

        await say(app, id, "Try the configured notification");
        assert.match((await modelTexts(app, id)).at(-1) ?? "", /Could not read notifier settings/);
        const request = JSON.parse(modelRequests.at(-1)!) as {
            messages: { role: string; isError?: boolean }[];
        };

        assert.equal(
            request.messages.findLast((message) => message.role === "toolResult")?.isError,
            true,
        );

        for (const secret of [token, endpointSecret]) {
            assert.equal(logged.map(String).join("\n").includes(secret), false);
            assert.equal(
                modelRequests.some((request) => request.includes(secret)),
                false,
            );
        }
    } finally {
        writeFileSync(file, original);
    }
});

test("configuration secrets are absent from committed Durable history and real Markdown exports", async () => {
    const counts = assertNoDurableSecrets();

    assert.ok(
        counts.tasks > 0 && counts.entries > 0,
        "the probe must include actual completed work",
    );

    for (const conversation of app.sessions(owner(app))) {
        const response = await fetch(`${base}/api/c/${conversation.id}/export`, {
            headers: { authorization: `Bearer ${app.config.ownerToken}` },
        });

        assert.equal(response.status, 200);
        const markdown = await response.text();

        assert.ok(markdown.length > 0);
        assert.equal(markdown.includes(token), false);
        assert.equal(markdown.includes(endpointSecret), false);
    }
});

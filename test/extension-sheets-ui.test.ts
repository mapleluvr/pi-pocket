import { cleanUp, owner, root, until, work, type App } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let rpcCalls = 0;
let assetCalls = 0;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function addBundle(
    id: string,
    title: string,
    web: string,
    server = "",
    assets: Record<string, string> = {},
): Promise<void> {
    const directory = join(app.dataDir, "extensions", id);

    mkdirSync(join(directory, "web"), { recursive: true });
    writeFileSync(join(directory, "web", "sheet.js"), web);

    for (const [name, content] of Object.entries(assets)) {
        const file = join(directory, "web", name);

        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
    }

    writeFileSync(
        join(directory, "index.ts"),
        `/** A native GUI. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default (host) => {
    host.sheets.register({ title: ${JSON.stringify(title)}, wide: true });
    ${server}
    return [];
};`,
    );
    await app.setExtensionEnabled(owner(app), id, true);
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    // Only this test process: remove inherited credentials by name, without reading their values.
    for (const name of Object.keys(process.env)) {
        if (
            /(?:API_KEY|TOKEN|CREDENTIALS|CLIENT_SECRET|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_PROFILE)$/i.test(
                name,
            )
        ) {
            delete process.env[name];
        }
    }

    // helpers.ts has isolated Pi's auth/settings. Do not register even a fake model for these GUI tests.
    app = await PocketApp.open({
        dataDir: join(root, "data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
    });
    assert.equal(
        (await app.models.getAvailable()).length,
        0,
        "this test must have no available model",
    );
    await addBundle(
        "counter-panel",
        "Counter panel",
        `
import { useState } from "preact/hooks";
import { html } from "/ui.js";
import { caption } from "./caption.js";
export default function Counter({ host }) {
    const [count, setCount] = useState(0);
    return html\`<p id="counter-value">\${caption} \${count}</p>
        <button id="increase" onClick=\${() => { setCount(count + 1); host.notify("info", "Counter changed"); }}>Increase</button>
        <button id="done" onClick=\${host.close}>Done</button>\`;
}
`,
        "",
        { "caption.js": 'export const caption = "Count:";' },
    );
    await addBundle(
        "rpc-panel",
        "RPC panel",
        `
import { useState } from "preact/hooks";
import { html } from "/ui.js";
export default function RpcPanel({ host }) {
    globalThis.nativeSheetHost = host;
    const [count, setCount] = useState(0);
    const run = async () => {
        try {
            const result = await host.rpc("increment", { amount: 1 });
            setCount(result.count);
            host.notify("info", "Private update finished");
        } catch (error) { host.notify("error", error.message); }
        finally { if (globalThis.closeWhenFinished) host.close(); }
    };
    return html\`<p id="rpc-value">Saved: \${count}</p><button id="run" onClick=\${run}>Run</button>\`;
}
`,
        `
    host.rpc.handle((_action, payload) => {
        if (_action === "false") return false;
        if (_action === "zero") return 0;
        if (_action === "empty") return "";
        if (_action === "nothing") return undefined;
        const file = join(host.dataDir, "gui-count.json");
        const count = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).count : 0) + payload.amount;
        writeFileSync(file, JSON.stringify({ count }));
        return { count };
    });
`,
    );
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        if (request.url?.endsWith("/rpc")) {
            rpcCalls++;
        }

        if (request.url?.includes("/assets/")) {
            assetCalls++;
        }

        return handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "native-sheets-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            await inPage<boolean>(`
        const { store } = await import("/store.js");
        return JSON.stringify(store.state.me?.role === "owner" &&
            store.state.server?.extensionSheets?.some((sheet) => sheet.moduleId === "counter-panel"));
    `),
        "authenticated app with Sheet metadata",
        20_000,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function open(id: string): Promise<void> {
    await page.evaluate(`
        const { openSheet } = await import("/store.js");
        openSheet({ type: "menu" });
    `);
    await until(
        async () =>
            await inPage<boolean>(`
        const item = [...document.querySelectorAll(".sheet button")].find((button) => button.textContent.includes("Extensions"));
        if (item) item.click();
        return JSON.stringify(!!item);
    `),
        "Extensions menu item",
    );
    await until(
        async () =>
            await inPage<boolean>(`
        return JSON.stringify([...document.querySelectorAll(".extension-title")].some((title) => title.textContent.trim() === ${JSON.stringify(id)}));
    `),
        "extension management row",
    );
    const target = await inPage<{ opened: boolean; height: number }>(`
        const row = [...document.querySelectorAll(".extension")].find((row) => row.querySelector(".extension-title").textContent.trim() === ${JSON.stringify(id)});
        const button = [...row.querySelectorAll("button")].find((button) => button.textContent.trim() === "Open");
        const height = button?.getBoundingClientRect().height ?? 0;
        if (button) button.click();
        return JSON.stringify({ opened: !!button, height });
    `);

    assert.ok(target.opened, "the management page must expose the native Open button");
    assert.ok(
        target.height >= 38,
        `Open needs an approximately 40px touch target, got ${target.height}`,
    );
}

test(
    "a GUI-only module opens from Extensions with no session or available model",
    real,
    async () => {
        await open("counter-panel");
        await until(
            async () =>
                await inPage<boolean>(
                    'return JSON.stringify(!!document.querySelector("#increase"));',
                ),
            "native counter component",
        );
        // Click after the Sheet stops moving, using a trusted pointer event to arm the real back stack.
        await until(
            async () =>
                await inPage<boolean>(`
        return JSON.stringify(!document.getAnimations().some((animation) =>
            animation.playState === "running" && animation.effect?.target?.closest?.(".sheet-host")));
    `),
            "the Sheet entry animation finishes",
        );
        const clicked = await page.click({ selector: "#increase" });

        assert.equal(clicked.covered, undefined, JSON.stringify(clicked));
        await until(
            async () =>
                await inPage<boolean>(
                    'return JSON.stringify(document.querySelector("#counter-value")?.textContent === "Count: 1");',
                ),
            "the component's own interaction",
        );
        const result = await inPage<{
            dialogs: number;
            title: string;
            wide: boolean;
            overflow: boolean;
        }>(`
        return JSON.stringify({ dialogs: document.querySelectorAll('[role="dialog"]').length,
            title: document.querySelector(".sheet h2").textContent,
            wide: document.querySelector(".sheet").classList.contains("wide"),
            overflow: document.documentElement.scrollWidth > innerWidth });
    `);

        assert.deepEqual(result, {
            dialogs: 1,
            title: "Counter panel",
            wide: true,
            overflow: false,
        });
        assert.equal(rpcCalls, 0);
        assert.equal((await app.models.getAvailable()).length, 0);
        assert.deepEqual(app.sessions(owner(app)), []);
        await until(
            async () =>
                await inPage<boolean>(
                    "return JSON.stringify(history.state?.pocket?.layers === 3);",
                ),
            "the real back stack is armed",
        );
        await page.evaluate("history.back();");
        await until(
            async () =>
                await inPage<boolean>(
                    "return JSON.stringify(!!document.querySelector('section[aria-label=\"Extensions\"]'));",
                ),
            "back returns to Extensions",
        );
    },
);

test(
    "a native component uses its bound RPC and private notice without invoking a model",
    real,
    async () => {
        await open("rpc-panel");
        await until(
            async () =>
                await inPage<boolean>('return JSON.stringify(!!document.querySelector("#run"));'),
            "native RPC component",
        );
        await page.evaluate('document.querySelector("#run").click();');
        await until(
            async () =>
                await inPage<boolean>(
                    'return JSON.stringify(document.querySelector("#rpc-value")?.textContent === "Saved: 1");',
                ),
            "native RPC result",
        );
        assert.deepEqual(JSON.parse(readFileSync(join(app.dataDir, "gui-count.json"), "utf8")), {
            count: 1,
        });
        assert.equal(rpcCalls, 1);
        assert.deepEqual(app.sessions(owner(app)), []);
    },
);

const count = () =>
    existsSync(join(app.dataDir, "gui-count.json"))
        ? (JSON.parse(readFileSync(join(app.dataDir, "gui-count.json"), "utf8")).count as number)
        : 0;

async function ready(selector: string): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(!!document.querySelector(${JSON.stringify(selector)}));`,
            ),
        selector,
    );
}

async function refreshPage(): Promise<void> {
    await page.reload();
    await until(
        async () =>
            await inPage<boolean>(`
        const { store } = await import("/store.js");
        return JSON.stringify(store.state.me?.role === "owner" && !!store.state.server?.extensionSheets);
    `),
        "the refreshed app",
        20_000,
    );
}

test(
    "the browser RPC accepts falsy data and null without treating them as a failed envelope",
    real,
    async () => {
        await open("rpc-panel");
        await ready("#run");

        for (const [action, expected] of [
            ["false", false],
            ["zero", 0],
            ["empty", ""],
            ["nothing", null],
        ] as const) {
            const result = await inPage<unknown>(
                `return JSON.stringify(await nativeSheetHost.rpc(${JSON.stringify(action)}, {}));`,
            );

            assert.equal(result, expected);
        }
    },
);

test(
    "malformed successful responses never report success, leak raw text, or repeat the real write",
    real,
    async () => {
        await open("rpc-panel");
        await ready("#run");
        const marker = "BAD_RESPONSE_PRIVATE_SENTINEL";

        for (const [body, status] of [
            ["", 200],
            [marker, 200],
            ["{}", 200],
            ['{"ok":true}', 200],
            ['{"ok":false,"data":1}', 200],
            ['[{"ok":true,"data":1}]', 200],
            [null, 204],
        ] as const) {
            const before = count();
            const calls = rpcCalls;
            const notice = await inPage<number>(`
            const { store } = await import("/store.js");
            return JSON.stringify(store.state.notices.at(-1)?.id ?? 0);
        `);

            await page.evaluate(`
            globalThis.originalFetch = globalThis.fetch;
            globalThis.fetch = async (...args) => {
                const response = await originalFetch(...args);
                if (String(args[0]).endsWith("/rpc")) {
                    await response.clone().text();
                    return new Response(${JSON.stringify(body)}, { status: ${status} });
                }
                return response;
            };
            document.querySelector("#run").click();
        `);

            try {
                await until(
                    async () =>
                        await inPage<boolean>(`
                const { store } = await import("/store.js");
                return JSON.stringify((store.state.notices.at(-1)?.id ?? 0) > ${notice});
            `),
                    "protocol failure notice",
                );
                const feedback = await inPage<{ level: string; message: string; value: string }>(`
                const { store } = await import("/store.js");
                return JSON.stringify({ ...store.state.notices.at(-1), value: document.querySelector("#rpc-value").textContent });
            `);

                assert.equal(feedback.level, "error");
                assert.match(feedback.message, /may already have taken effect/);
                assert.equal(feedback.message.includes(marker), false);
                assert.equal(feedback.value, "Saved: 0");
                assert.equal(count(), before + 1);
                assert.equal(rpcCalls, calls + 1);
            } finally {
                await page.evaluate("globalThis.fetch = originalFetch;");
            }
        }

        assert.equal(
            page.logs().some((log) => log.text.includes(marker)),
            false,
        );
    },
);

test("a lost response is not replayed, even when the browser refreshes", real, async () => {
    await open("rpc-panel");
    await ready("#run");
    const before = count();
    const calls = rpcCalls;
    const notice = await inPage<number>(
        `const { store } = await import("/store.js"); return JSON.stringify(store.state.notices.at(-1)?.id ?? 0);`,
    );

    await page.evaluate(`
        globalThis.originalFetch = globalThis.fetch;
        globalThis.fetch = async (...args) => {
            const response = await originalFetch(...args);
            if (String(args[0]).endsWith("/rpc")) {
                await response.clone().text();
                throw new Error("LOST_RESPONSE_PRIVATE_SENTINEL");
            }
            return response;
        };
        document.querySelector("#run").click();
    `);
    await until(() => count() === before + 1, "the write finished before losing its response");
    await until(
        async () =>
            await inPage<boolean>(`
        const { store } = await import("/store.js");
        return JSON.stringify(store.state.notices.at(-1)?.level === "error" && store.state.notices.at(-1).id > ${notice});
    `),
        "the unknown-outcome notice",
    );
    await refreshPage();
    assert.equal(count(), before + 1);
    assert.equal(rpcCalls, calls + 1);
});

test(
    "an old callback cannot notify or close a different Sheet after a late RPC response",
    real,
    async () => {
        await open("rpc-panel");
        await ready("#run");
        const before = count();

        await page.evaluate(`
        globalThis.originalFetch = globalThis.fetch;
        globalThis.closeWhenFinished = true;
        globalThis.rpcArrived = false;
        globalThis.fetch = async (...args) => {
            const response = await originalFetch(...args);
            if (String(args[0]).endsWith("/rpc")) {
                await response.clone().text();
                globalThis.rpcArrived = true;
                await new Promise((resolve) => { globalThis.releaseRpc = resolve; });
            }
            return response;
        };
        document.querySelector("#run").click();
    `);

        try {
            await until(
                async () => await inPage<boolean>("return JSON.stringify(rpcArrived);"),
                "the held real response",
            );
            assert.equal(count(), before + 1);
            await open("counter-panel");
            await ready("#increase");
            const notice = await inPage<number>(
                `const { store } = await import("/store.js"); return JSON.stringify(store.state.notices.at(-1)?.id ?? 0);`,
            );

            await page.evaluate(
                "releaseRpc(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);",
            );
            assert.equal(
                await inPage<boolean>(
                    'return JSON.stringify(!!document.querySelector("#increase"));',
                ),
                true,
            );
            assert.ok(
                await inPage<boolean>(
                    `const { store } = await import("/store.js"); return JSON.stringify((store.state.notices.at(-1)?.id ?? 0) <= ${notice});`,
                ),
            );
        } finally {
            await page.evaluate(
                "globalThis.closeWhenFinished = false; globalThis.fetch = originalFetch; globalThis.releaseRpc?.();",
            );
        }
    },
);

test("late dynamic imports cannot replace the currently open component", real, async () => {
    await addBundle(
        "late-panel",
        "Late panel",
        `
        import { html } from "/ui.js";
        await new Promise((resolve) => { globalThis.finishImport = resolve; globalThis.importEntered = true; });
        globalThis.importFinished = true;
        export default () => html\`<p id="late-content">Late content</p>\`;
    `,
    );
    await open("late-panel");
    await until(
        async () =>
            await inPage<boolean>("return JSON.stringify(globalThis.importEntered === true);"),
        "the pending import",
    );
    await open("counter-panel");
    await ready("#increase");
    await page.evaluate("finishImport();");
    await until(
        async () =>
            await inPage<boolean>("return JSON.stringify(globalThis.importFinished === true);"),
        "the old import finishes",
    );
    assert.equal(
        await inPage<boolean>(
            'return JSON.stringify(!!document.querySelector("#increase") && !document.querySelector("#late-content"));',
        ),
        true,
    );
});

test("rapidly reopening the same module gives it a new callback scope", real, async () => {
    await open("rpc-panel");
    await ready("#run");
    const calls = rpcCalls;

    await page.evaluate(`
        const { closeSheet, openSheet, store } = await import("/store.js");
        globalThis.oldHost = nativeSheetHost;
        const previous = store.state.sheet;
        closeSheet();
        openSheet({ ...previous });
    `);
    await until(
        async () => await inPage<boolean>("return JSON.stringify(nativeSheetHost !== oldHost);"),
        "the new instance",
    );
    const result = await inPage<{ active: boolean; notices: number; failed: boolean }>(`
        const { store } = await import("/store.js");
        const before = store.state.notices.length;
        oldHost.close();
        oldHost.notify("info", "stale notification");
        let failed = false;
        try { await oldHost.rpc("increment", { amount: 1 }); } catch { failed = true; }
        return JSON.stringify({ active: store.state.sheet?.id === "rpc-panel", notices: store.state.notices.length - before, failed });
    `);

    assert.deepEqual(result, { active: true, notices: 0, failed: true });
    assert.equal(rpcCalls, calls);
});

test(
    "import and render errors are contained without logging their original values",
    real,
    async () => {
        const marker = "GUI_EXCEPTION_PRIVATE_SENTINEL";
        const logStart = page.logSeq;

        for (const [id, source] of [
            ["bad-import", `throw new Error(${JSON.stringify(marker)});`],
            ["bad-render", `export default () => { throw new Error(${JSON.stringify(marker)}); };`],
        ] as const) {
            await addBundle(id, id, source);
            await open(id);
            await ready(".sheet .error-box");
            const text = await inPage<string>(
                'return JSON.stringify(document.querySelector(".sheet").textContent);',
            );

            assert.equal(text.includes(marker), false);
            assert.match(text, /could not (load|render)/);
            await page.press("Escape");
            await until(
                async () =>
                    await inPage<boolean>(
                        'const { store } = await import("/store.js"); return JSON.stringify(store.state.sheet === null);',
                    ),
                "the host still closes a failed interface",
            );
        }

        assert.equal(
            page.logs(logStart).some((log) => log.text.includes(marker)),
            false,
        );
    },
);

test("client serialization errors are generic and never send a request", real, async () => {
    await open("rpc-panel");
    await ready("#run");
    const calls = rpcCalls;
    const message = await inPage<string>(`
        try { await nativeSheetHost.rpc("increment", { toJSON() { throw new Error("CLIENT_PRIVATE_SENTINEL"); } }); }
        catch (error) { return JSON.stringify(error.message); }
    `);

    assert.equal(message.includes("CLIENT_PRIVATE_SENTINEL"), false);
    assert.match(message, /not retried/);
    assert.equal(rpcCalls, calls);
});

test(
    "a loaded module needs a full refresh after reload, including its relative dependencies",
    real,
    async () => {
        await open("counter-panel");
        await ready("#increase");
        writeFileSync(
            join(app.dataDir, "extensions", "counter-panel", "web", "caption.js"),
            'export const caption = "Fresh count:";',
        );
        await app.loader.reload("counter-panel");
        await ready(".sheet .error-box");
        assert.equal(
            await inPage<boolean>('return JSON.stringify(!document.querySelector("#increase"));'),
            true,
        );
        await open("counter-panel");
        await ready(".sheet .error-box");
        assert.match(
            await inPage<string>(
                'return JSON.stringify(document.querySelector(".sheet .error-box").textContent);',
            ),
            /Refresh the page/,
        );
        await refreshPage();
        await open("counter-panel");
        await ready("#increase");
        assert.equal(
            await inPage<string>(
                'return JSON.stringify(document.querySelector("#counter-value").textContent);',
            ),
            "Fresh count: 0",
        );
    },
);

test(
    "disabling an open module invalidates its content but leaves the host's close control working",
    real,
    async () => {
        await open("rpc-panel");
        await ready("#run");
        await app.setExtensionEnabled(owner(app), "rpc-panel", false);
        await ready(".sheet .error-box");
        assert.equal(
            await inPage<boolean>('return JSON.stringify(!document.querySelector("#run"));'),
            true,
        );
        await page.press("Escape");
        await until(
            async () =>
                await inPage<boolean>(
                    'const { store } = await import("/store.js"); return JSON.stringify(store.state.sheet === null);',
                ),
            "close after invalidation",
        );
        await app.setExtensionEnabled(owner(app), "rpc-panel", true);
    },
);

test(
    "a guest has no Open entry and cannot load content by forging a sheet descriptor",
    real,
    async () => {
        const guest = app.config.addUser("GUI guest", "guest");
        const guestPage = await browsers.open(2);

        await guestPage.setViewport(VIEWPORTS.mobile);
        await guestPage.navigate(`${base}/login?token=${encodeURIComponent(guest.token)}`);
        await until(
            async () =>
                JSON.parse(
                    await guestPage.evaluate(`
        const { store } = await import("/store.js");
        return JSON.stringify(store.state.me?.role === "guest");
    `),
                ),
            "guest signed in",
        );
        await guestPage.evaluate(
            'const { openSheet } = await import("/store.js"); openSheet({ type: "extensions" });',
        );
        await until(
            async () =>
                JSON.parse(
                    await guestPage.evaluate(
                        'return JSON.stringify(!!document.querySelector(".extension"));',
                    ),
                ),
            "guest module list",
        );
        assert.equal(
            JSON.parse(
                await guestPage.evaluate(`
        return JSON.stringify([...document.querySelectorAll(".extension button")]
            .some((button) => button.textContent.trim() === "Open"));
    `),
            ),
            false,
        );
        const definition = app.loader.sheets().find((each) => each.moduleId === "counter-panel")!;
        const calls = assetCalls;

        await guestPage.evaluate(`
        const { openSheet } = await import("/store.js");
        openSheet(${JSON.stringify({ type: "extension", id: definition.moduleId, definition })});
    `);
        await until(
            async () =>
                JSON.parse(
                    await guestPage.evaluate(
                        'return JSON.stringify(!!document.querySelector(".sheet .error-box"));',
                    ),
                ),
            "forged guest sheet is unavailable",
        );
        assert.equal(assetCalls, calls);
        assert.equal(
            JSON.parse(
                await guestPage.evaluate(
                    'return JSON.stringify(!!document.querySelector("#increase"));',
                ),
            ),
            false,
        );
    },
);

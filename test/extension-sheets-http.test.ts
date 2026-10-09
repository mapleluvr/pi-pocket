import { cleanUp, fakeTab, openApp, owner, scriptedModel, until, type App } from "./helpers.ts";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import type { SheetInfo } from "../src/server/host.ts";

const secret = "RPC_PRIVATE_SENTINEL_83fb2";
let app: App;
let server: Server;
let base = "";
let directory = "";
let sheet: SheetInfo;
let modelCalls = 0;
let ownerTab: ReturnType<typeof fakeTab>;
let peerTab: ReturnType<typeof fakeTab>;

before(async () => {
    app = await openApp(
        scriptedModel(() => {
            modelCalls++;

            throw new Error("A Sheet RPC must not call the model");
        }),
    );
    directory = join(app.dataDir, "extensions", "native-ui");
    mkdirSync(join(directory, "web", "nested"), { recursive: true });
    writeFileSync(join(directory, "private.json"), JSON.stringify({ token: secret }));
    writeFileSync(join(directory, "web", ".hidden.js"), secret);
    writeFileSync(join(directory, "web", "source.ts"), secret);
    writeFileSync(
        join(directory, "web", "sheet.js"),
        'export { default } from "./nested/view.js";\n',
    );
    writeFileSync(join(directory, "web", "nested", "view.js"), "export default () => null;\n");
    writeFileSync(
        join(directory, "web", "icon.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    writeFileSync(
        join(directory, "index.ts"),
        `/** A private native GUI. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
export default (host) => {
    host.sheets.register({ title: "Native UI" });
    host.rpc?.handle(async (action, payload, ctx) => {
        if (action === "version") return "handler-version-1";
        if (action === "hold") {
            writeFileSync(new URL("started-" + payload.id, import.meta.url), "started");
            while (!existsSync(new URL("release-" + payload.id, import.meta.url))) await delay(5);
            return "handler-version-1";
        }
        if (action === "save") {
            writeFileSync(new URL("private.json", import.meta.url), JSON.stringify(payload));
            return { configured: true, by: ctx.user.id };
        }
        if (action === "nothing") return undefined;
        if (action === "primitive") return false;
        if (action === "array") return [1, null, "three"];
        if (action === "fail") throw new Error(payload.token);
        if (action === "bigint") return BigInt(1);
        if (action === "function") return () => {};
        if (action === "circular") { const value = { payload }; value.self = value; return value; }
        if (action === "serialize") return { toJSON() { throw new Error(payload.token); } };
        return { configured: !!JSON.parse(readFileSync(new URL("private.json", import.meta.url))).token };
    });
    return [];
};
`,
    );
    await app.setExtensionEnabled(owner(app), "native-ui", true);
    sheet = app.loader.sheets().find((each) => each.moduleId === "native-ui")!;
    ownerTab = fakeTab(undefined, owner(app));
    peerTab = fakeTab(undefined, app.config.addUser("Peer", "guest").user);
    await app.attach(ownerTab.client);
    await app.attach(peerTab.client);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    assert.ok(address !== null && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    app.detach(ownerTab.client);
    app.detach(peerTab.client);
    await app?.close();
    cleanUp();
});

function get(path: string, token = app.config.ownerToken): Promise<Response> {
    return fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
}

function rpc(
    action: string,
    payload: unknown = {},
    options: { token?: string; generation?: string; pocket?: boolean } = {},
): Promise<Response> {
    return fetch(`${base}/api/extensions/native-ui/rpc`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${options.token ?? app.config.ownerToken}`,
            "content-type": "application/json",
            ...(options.pocket === false ? {} : { "x-pocket": "1" }),
        },
        body: JSON.stringify({
            generation: options.generation ?? sheet.generation,
            action,
            payload,
        }),
    });
}

test("an owner loads only the accepted web files, with JavaScript MIME and no caching", async () => {
    const response = await get(sheet.entry);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), readFileSync(join(directory, "web", "sheet.js"), "utf8"));
    const nested = await get(sheet.entry.replace("sheet.js", "nested/view.js"));

    assert.equal(nested.status, 200);
    assert.equal(await nested.text(), "export default () => null;\n");
});

test("assets and RPC require the owner, and writes require the existing CSRF header", async () => {
    for (const role of ["guest", "viewer"] as const) {
        const { token } = app.config.addUser(`RPC ${role}`, role);

        assert.equal((await get(sheet.entry, token)).status, 403);
        assert.equal((await rpc("save", { token: secret }, { token })).status, 403);
    }

    assert.equal((await get(sheet.entry, "invalid")).status, 401);
    assert.equal((await rpc("save", {}, { pocket: false })).status, 403);
    assert.equal((await rpc("save", {}, { generation: "other-generation" })).status, 409);
});

test("backend, hidden, unsupported and traversing paths are not served", async () => {
    const prefix = sheet.entry.slice(0, -"sheet.js".length);

    for (const path of [
        ".hidden.js",
        "source.ts",
        "private.json",
        "%2e%2e%2fprivate.json",
        "%2e%2e%5cprivate.json",
        "%2e%2e%2findex.ts",
        "C%3A%5cprivate.json",
    ]) {
        const response = await get(prefix + path);

        assert.equal(response.status, 404, path);
        assert.equal((await response.text()).includes(secret), false);
    }
});

test("an SVG opened as a document has the host's sandbox policy", async () => {
    const response = await get(sheet.entry.replace("sheet.js", "icon.svg"));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/svg+xml");
    assert.match(response.headers.get("content-security-policy") ?? "", /^sandbox;/);
});

test("RPC saves privately without a conversation, model request, or broadcast", async () => {
    ownerTab.events.length = 0;
    peerTab.events.length = 0;
    const response = await rpc("save", { token: secret });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        ok: true,
        data: { configured: true, by: owner(app).id },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "private.json"), "utf8")), {
        token: secret,
    });
    assert.deepEqual(ownerTab.events, []);
    assert.deepEqual(peerTab.events, []);
    assert.equal(modelCalls, 0);
    assert.deepEqual(app.sessions(owner(app)), []);
});

test("every JSON result uses the same success envelope, including void", async () => {
    for (const [action, data] of [
        ["nothing", null],
        ["primitive", false],
        ["array", [1, null, "three"]],
    ] as const) {
        const response = await rpc(action);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, data });
    }
});

test("changed entry or lazy-import bytes are rejected even with unchanged size and timestamps", async () => {
    for (const name of ["sheet.js", "nested/view.js"]) {
        const file = join(directory, "web", name);
        const original = readFileSync(file, "utf8");
        const stats = statSync(file);

        try {
            writeFileSync(file, original.replace("export", "EXPORT"));
            utimesSync(file, stats.atime, stats.mtime);
            const response = await get(sheet.entry.replace("sheet.js", name));

            assert.equal(response.status, 409, name);
            assert.equal((await response.text()).includes("EXPORT"), false);
        } finally {
            writeFileSync(file, original);
            utimesSync(file, stats.atime, stats.mtime);
        }
    }
});

test("malformed RPC requests fail without echoing their payload", async () => {
    for (const body of [
        "null",
        "[]",
        JSON.stringify({ generation: sheet.generation, payload: secret }),
        secret,
    ]) {
        const response = await fetch(`${base}/api/extensions/native-ui/rpc`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "content-type": "application/json",
                "x-pocket": "1",
            },
            body,
        });

        assert.equal(response.status, 400);
        assert.equal((await response.text()).includes(secret), false);
    }
});

test("handler and serialization failures neither return nor log the original value", async (t) => {
    const logged: unknown[] = [];

    t.mock.method(console, "error", (...args: unknown[]) => logged.push(...args));

    for (const action of ["fail", "bigint", "function", "circular", "serialize"]) {
        const response = await rpc(action, { token: secret });

        assert.equal(response.status, 500, action);
        assert.deepEqual(await response.json(), { error: "extension_error" });
    }

    assert.equal(logged.map(String).join("\n").includes(secret), false);
    assert.equal(JSON.stringify(ownerTab.events).includes(secret), false);
    assert.equal(JSON.stringify(peerTab.events).includes(secret), false);
});

async function reload(): Promise<void> {
    await app.loader.reload("native-ui");
    sheet = app.loader.sheets().find((each) => each.moduleId === "native-ui")!;
}

function privateRootBundle(id: string) {
    const folder = join(app.dataDir, "extensions", id);
    const web = join(folder, "web");
    const privateDir = join(folder, "private");
    const source = `/** A GUI with private sibling data. */
export default (host) => {
    host.sheets.register({ title: "Accepted UI" });
    host.rpc.handle(() => "accepted");
    return [];
};\n`;

    for (const path of [web, privateDir]) {
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "sheet.js"), "export default () => null;\n");
    }

    writeFileSync(join(privateDir, "config.json"), JSON.stringify({ secret }));
    writeFileSync(join(folder, "index.ts"), source);

    return { folder, web, privateDir, source };
}

test("a same-package private directory cannot become the web root through a link", async () => {
    const { web, privateDir } = privateRootBundle("linked-private-start");

    rmSync(web, { recursive: true });
    symlinkSync(privateDir, web, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(app.setExtensionEnabled(owner(app), "linked-private-start", true));
    assert.equal(
        app.loader.sheets().some((each) => each.moduleId === "linked-private-start"),
        false,
    );
    const response = await get(
        "/api/extensions/linked-private-start/assets/unaccepted/config.json",
    );

    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes(secret), false);
});

test("a linked private root cannot replace an accepted Sheet or RPC", async () => {
    const id = "linked-private-reload";
    const { folder, web, privateDir, source } = privateRootBundle(id);
    const saved = join(folder, "accepted-web");

    await app.setExtensionEnabled(owner(app), id, true);
    const previous = app.loader.sheets().find((each) => each.moduleId === id)!;
    const generation = previous.generation;

    assert.equal((await get(previous.entry)).status, 200);
    renameSync(web, saved);
    symlinkSync(privateDir, web, process.platform === "win32" ? "junction" : "dir");

    try {
        writeFileSync(
            join(folder, "index.ts"),
            source.replace("Accepted UI", "Candidate UI").replace('"accepted"', '"candidate"'),
        );
        await assert.rejects(app.loader.reload(id));
        const current = app.loader.sheets().find((each) => each.moduleId === id)!;

        assert.equal(current.generation, generation);
        assert.equal(current.title, "Accepted UI");
        const response = await fetch(`${base}/api/extensions/${id}/rpc`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "content-type": "application/json",
                "X-Pocket": "1",
            },
            body: JSON.stringify({ generation, action: "version" }),
        });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, data: "accepted" });
        assert.equal((await get(previous.entry)).status, 409);
        const privateResponse = await get(previous.entry.replace("sheet.js", "config.json"));

        assert.equal(privateResponse.status, 404);
        assert.equal((await privateResponse.text()).includes(secret), false);
    } finally {
        rmSync(web, { recursive: true, force: true });
        renameSync(saved, web);
        writeFileSync(join(folder, "index.ts"), source);
        await app.loader.reload(id);
    }
});

test("prototype-named directory modules retain string titles in the discovery API", async () => {
    for (const id of ["constructor", "toString"]) {
        const folder = join(app.dataDir, "extensions", id);

        mkdirSync(join(folder, "web"), { recursive: true });
        writeFileSync(join(folder, "web", "sheet.js"), "export default () => null;\n");
        writeFileSync(
            join(folder, "index.ts"),
            'export default (host) => { host.sheets.register({ title: "Own GUI" }); return []; };',
        );
    }

    const response = await get("/api/extensions");
    const info = (await response.json()) as Awaited<ReturnType<App["extensions"]>>;

    assert.equal(response.status, 200);

    for (const id of ["constructor", "toString"]) {
        const module = info.modules.find((each) => each.file === id)!;

        assert.equal(module.title, id);
        assert.equal(module.enabled, false);
        await app.setExtensionEnabled(owner(app), id, true);
        assert.equal(app.loader.sheets().find((each) => each.moduleId === id)?.title, "Own GUI");
    }
});

test("junctions cannot expose files outside web or replace the web root with a private folder", async () => {
    const outside = join(app.dataDir, "not-public");
    const link = join(directory, "web", "escape");
    const linked = join(app.dataDir, "extensions", "linked-ui");

    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sheet.js"), secret);
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

    try {
        await reload();
        assert.equal((await get(sheet.entry)).status, 200);
        const response = await get(sheet.entry.replace("sheet.js", "escape/sheet.js"));

        assert.equal(response.status, 404);
        assert.equal((await response.text()).includes(secret), false);
        mkdirSync(linked);
        writeFileSync(
            join(linked, "index.ts"),
            'export default (host) => { host.sheets.register({ title: "Linked" }); return []; };',
        );
        symlinkSync(
            outside,
            join(linked, "web"),
            process.platform === "win32" ? "junction" : "dir",
        );
        await assert.rejects(app.setExtensionEnabled(owner(app), "linked-ui", true));
        assert.equal(
            app.loader.sheets().some((each) => each.moduleId === "linked-ui"),
            false,
        );
    } finally {
        rmSync(link, { recursive: true, force: true });
        await reload();
    }
});

test("failed reload retains the old RPC but cannot serve edited assets as the old generation", async () => {
    const source = join(directory, "index.ts");
    const asset = join(directory, "web", "nested", "view.js");
    const original = readFileSync(source, "utf8");
    const originalAsset = readFileSync(asset, "utf8");
    const previous = sheet;

    try {
        writeFileSync(source, "export default () => { throw new Error('broken rebuild'); };");
        writeFileSync(asset, originalAsset.replace("null", "true"));
        await assert.rejects(app.loader.reload("native-ui"));
        assert.equal(
            app.loader.sheets().find((each) => each.moduleId === "native-ui")?.generation,
            previous.generation,
        );
        const result = await rpc("version");

        assert.equal(result.status, 200);
        assert.deepEqual(await result.json(), { ok: true, data: "handler-version-1" });
        assert.equal((await get(previous.entry)).status, 200);
        assert.equal((await get(previous.entry.replace("sheet.js", "nested/view.js"))).status, 409);
    } finally {
        writeFileSync(source, original);
        writeFileSync(asset, originalAsset);
        await reload();
    }
});

test("dispatch rechecks disable and generation changes after the request body arrives", async () => {
    for (const change of ["disable", "reload"]) {
        const arrived = Promise.withResolvers<void>();
        const outcome = Promise.withResolvers<number>();
        const previous = sheet;
        const seen = () => arrived.resolve();

        server.once("request", seen);
        const request = httpRequest(
            `${base}/api/extensions/native-ui/rpc`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${app.config.ownerToken}`,
                    "content-type": "application/json",
                    "x-pocket": "1",
                },
            },
            (response) => {
                response.resume();
                response.on("end", () => outcome.resolve(response.statusCode!));
            },
        );

        request.on("error", outcome.reject);
        request.write(
            `{"generation":${JSON.stringify(previous.generation)},"action":"save","payload":`,
        );
        await arrived.promise;

        try {
            if (change === "disable") {
                await app.setExtensionEnabled(owner(app), "native-ui", false);
            } else {
                await reload();
            }

            request.end(JSON.stringify({ token: "must-not-be-saved" }) + "}");
            assert.equal(await outcome.promise, change === "disable" ? 404 : 409);
            assert.equal(
                JSON.parse(readFileSync(join(directory, "private.json"), "utf8")).token,
                secret,
            );
            assert.equal((await get(previous.entry)).status, change === "disable" ? 404 : 409);
        } finally {
            server.off("request", seen);
            request.destroy();
            await app.setExtensionEnabled(owner(app), "native-ui", true);
            sheet = app.loader.sheets().find((each) => each.moduleId === "native-ui")!;
        }
    }
});

test("concurrent admitted calls finish on the old handler while new calls use the new generation", async () => {
    const source = join(directory, "index.ts");
    const original = readFileSync(source, "utf8");
    const previous = sheet;
    const pending = [rpc("hold", { id: "first" }), rpc("hold", { id: "second" })];

    try {
        await until(
            () =>
                existsSync(join(directory, "started-first")) &&
                existsSync(join(directory, "started-second")),
            "both handlers enter without a host queue",
        );
        writeFileSync(source, original.replaceAll("handler-version-1", "handler-version-2"));
        await reload();
        const result = await rpc("version");

        assert.deepEqual(await result.json(), { ok: true, data: "handler-version-2" });
        assert.equal((await rpc("version", {}, { generation: previous.generation })).status, 409);
        writeFileSync(join(directory, "release-first"), "go");
        writeFileSync(join(directory, "release-second"), "go");

        for (const response of await Promise.all(pending)) {
            assert.deepEqual(await response.json(), { ok: true, data: "handler-version-1" });
        }
    } finally {
        writeFileSync(join(directory, "release-first"), "go");
        writeFileSync(join(directory, "release-second"), "go");
        await Promise.allSettled(pending);
        writeFileSync(source, original);
        await reload();
    }
});

test("a custom nested mjs entry has a JavaScript MIME type and retains the wide declaration", async () => {
    const root = join(app.dataDir, "extensions", "alternate-ui");

    mkdirSync(join(root, "web", "nested"), { recursive: true });
    writeFileSync(
        join(root, "index.ts"),
        'export default (host) => { host.sheets.register({ title: "Alternate", entry: "nested/view.mjs", wide: true }); return []; };',
    );
    writeFileSync(join(root, "web", "nested", "view.mjs"), "export default () => null;");
    await app.setExtensionEnabled(owner(app), "alternate-ui", true);
    const definition = app.loader.sheets().find((each) => each.moduleId === "alternate-ui")!;

    assert.equal(definition.wide, true);
    assert.ok(definition.entry.endsWith("/nested/view.mjs"));
    const response = await fetch(base + definition.entry, {
        headers: { authorization: `Bearer ${app.config.ownerToken}` },
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "export default () => null;");
});

test("reopening PocketApp preserves enablement but not the old GUI generation or a replay", async () => {
    const dataDir = join(app.dataDir, "restart-check");
    const module = join(dataDir, "extensions", "restart-ui");
    const counter = join(dataDir, "calls.txt");
    const model = scriptedModel(() => {
        throw new Error("A GUI request must not invoke a model");
    });

    mkdirSync(join(module, "web"), { recursive: true });
    writeFileSync(join(module, "web", "sheet.js"), "export default () => null;");
    writeFileSync(
        join(module, "index.ts"),
        `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default (host) => {
    const file = join(host.dataDir, "calls.txt");
    host.sheets.register({ title: "Restart" });
    host.rpc.handle((action) => {
        const count = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
        if (action === "write") { writeFileSync(file, String(count + 1)); return count + 1; }
        return count;
    });
    return [];
};
`,
    );
    let previous: SheetInfo | undefined;

    for (let pass = 0; pass < 2; pass++) {
        const copy = await openApp(model, dataDir);
        const web = createServer(
            createHandler({
                app: copy,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );

        try {
            if (pass === 0) {
                await copy.setExtensionEnabled(owner(copy), "restart-ui", true);
            }

            const current = copy.loader.sheets().find((each) => each.moduleId === "restart-ui")!;

            assert.ok(current, "enabled GUI is installed at startup");
            await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
            const url = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
            const headers = {
                authorization: `Bearer ${copy.config.ownerToken}`,
                "content-type": "application/json",
                "x-pocket": "1",
            };
            const call = (generation: string, action: string) =>
                fetch(`${url}/api/extensions/restart-ui/rpc`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ generation, action }),
                });

            if (previous) {
                assert.notEqual(current.generation, previous.generation);
                assert.equal(readFileSync(counter, "utf8"), "1");
                const stale = await call(previous.generation, "write");

                assert.equal(stale.status, 409);
                await stale.text();
                const asset = await fetch(url + previous.entry, { headers });

                assert.equal(asset.status, 409);
                await asset.text();
                assert.deepEqual(await (await call(current.generation, "read")).json(), {
                    ok: true,
                    data: 1,
                });
                assert.equal(readFileSync(counter, "utf8"), "1");
            } else {
                assert.deepEqual(await (await call(current.generation, "write")).json(), {
                    ok: true,
                    data: 1,
                });
                previous = current;
            }

            assert.deepEqual(copy.sessions(owner(copy)), []);
        } finally {
            web.closeAllConnections();
            await new Promise<void>((resolve) => web.close(() => resolve()));
            await copy.close();
        }
    }
});

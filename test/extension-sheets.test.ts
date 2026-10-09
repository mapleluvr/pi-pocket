import { cleanUp, fakeTab, openApp, owner, scriptedModel, until, type App } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

let app: App;
let modelCalls = 0;

before(async () => {
    app = await openApp(
        scriptedModel(() => {
            modelCalls++;

            throw new Error("GUI discovery must not call the model");
        }),
    );
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a GUI-only directory module is opt-in and publishes its Sheet without a Tool or session", async () => {
    const directory = join(app.dataDir, "extensions", "native-counter");

    mkdirSync(join(directory, "web"), { recursive: true });
    writeFileSync(
        join(directory, "index.ts"),
        `/** An interactive counter. */
export default (host) => {
    host.sheets?.register({ title: "Counter" });
    return [];
};
`,
    );
    writeFileSync(join(directory, "web", "sheet.js"), "export default () => null;\n");

    const modules = (await app.extensions(owner(app))).modules;

    assert.equal(modules.find((module) => module.file === "native-counter")?.enabled, false);
    await app.setExtensionEnabled(owner(app), "native-counter", true);

    const sheet = (await app.hello(owner(app))).server.extensionSheets?.find(
        (each) => each.moduleId === "native-counter",
    );

    assert.ok(sheet, "the enabled GUI-only module must be discoverable");
    assert.equal(sheet.title, "Counter");
    assert.equal(sheet.wide, false);
    assert.match(sheet.entry, /^\/api\/extensions\/native-counter\/assets\/[^/]+\/sheet\.js$/);
    assert.equal(typeof sheet.generation, "string");
    assert.equal("handler" in sheet, false);
    assert.equal("assets" in sheet, false);
    assert.deepEqual(
        app.loader.list().find((module) => module.file === "native-counter")?.extensions,
        [],
    );
    assert.equal(modelCalls, 0);
});

function bundle(id: string, declaration: string): string {
    const directory = join(app.dataDir, "extensions", id);

    mkdirSync(join(directory, "web"), { recursive: true });
    writeFileSync(join(directory, "web", "sheet.js"), "export default () => null;\n");
    writeFileSync(
        join(directory, "index.ts"),
        `/** A test GUI. */\nexport default (host) => { ${declaration}; return []; };\n`,
    );

    return directory;
}

test("GUI discovery is owner-only", async () => {
    bundle("private-gui", 'host.sheets.register({ title: "Owner view" })');
    await app.setExtensionEnabled(owner(app), "private-gui", true);

    const guest = app.config.addUser("GUI guest", "guest").user;
    const viewer = app.config.addUser("GUI viewer", "viewer").user;

    assert.ok((await app.hello(owner(app))).server.extensionSheets.length > 0);
    assert.deepEqual((await app.hello(guest)).server.extensionSheets, []);
    assert.deepEqual((await app.hello(viewer)).server.extensionSheets, []);
});

test("disabling and removing a declaration retracts it from connected tabs", async () => {
    const directory = bundle("gui-lifecycle", 'host.sheets.register({ title: "Before" })');
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);

    try {
        await app.setExtensionEnabled(owner(app), "gui-lifecycle", true);
        const visible = () =>
            (
                tab.last("hello")?.server as Awaited<ReturnType<App["hello"]>>["server"]
            ).extensionSheets.find((sheet) => sheet.moduleId === "gui-lifecycle");
        const previous = visible();

        assert.ok(previous);
        writeFileSync(
            join(directory, "index.ts"),
            'export default (host) => { host.sheets.register({ title: "After" }); return []; };',
        );
        await app.loader.reload("gui-lifecycle");
        assert.equal(visible()?.title, "After");
        assert.notEqual(visible()?.generation, previous.generation);

        writeFileSync(join(directory, "index.ts"), "export default () => [];");
        await app.loader.reload("gui-lifecycle");
        assert.equal(visible(), undefined);

        bundle("gui-lifecycle", 'host.sheets.register({ title: "Enabled again" })');
        await app.loader.reload("gui-lifecycle");
        assert.ok(visible());
        await app.setExtensionEnabled(owner(app), "gui-lifecycle", false);
        assert.equal(visible(), undefined);
    } finally {
        app.detach(tab.client);
    }
});

test("invalid or duplicate Sheet declarations retain the previous generation", async () => {
    const directory = bundle("gui-invalid", 'host.sheets.register({ title: "Valid" })');

    await app.setExtensionEnabled(owner(app), "gui-invalid", true);
    const previous = app.loader.sheets().find((sheet) => sheet.moduleId === "gui-invalid");

    for (const declaration of [
        'host.sheets.register({ title: "One" }); host.sheets.register({ title: "Two" })',
        'host.sheets.register({ title: "" })',
        'host.sheets.register({ title: "Bad width", wide: "yes" })',
        'host.sheets.register({ title: "Escape", entry: "../index.ts" })',
        'host.sheets.register({ title: "RPC" }); host.rpc.handle(null)',
        'host.sheets.register({ title: "RPC" }); host.rpc.handle(() => 1); host.rpc.handle(() => 2)',
        "host.rpc.handle(() => 1)",
    ]) {
        writeFileSync(
            join(directory, "index.ts"),
            `export default (host) => { ${declaration}; return []; };`,
        );
        await assert.rejects(app.loader.reload("gui-invalid"));
        assert.deepEqual(
            app.loader.sheets().find((sheet) => sheet.moduleId === "gui-invalid"),
            previous,
        );
    }
});

test("a registration attempted after the factory returns is rejected", async () => {
    const directory = bundle(
        "gui-late",
        `host.sheets.register({ title: "On time" });
        queueMicrotask(() => {
            try {
                host.sheets.register({ title: "Too late" });
                writeFileSync(new URL("late.txt", import.meta.url), "accepted");
            } catch {
                writeFileSync(new URL("late.txt", import.meta.url), "rejected");
            }
        })`,
    );
    const path = join(directory, "index.ts");

    writeFileSync(path, 'import { writeFileSync } from "node:fs";\n' + readFileSync(path, "utf8"));
    await app.setExtensionEnabled(owner(app), "gui-late", true);
    assert.equal(readFileSync(join(directory, "late.txt"), "utf8"), "rejected");
    assert.equal(
        app.loader.sheets().find((sheet) => sheet.moduleId === "gui-late")?.title,
        "On time",
    );
});

test("the real watcher tracks code and assets, but ignores unsupported files and private data", async () => {
    const directory = bundle("watch-ui", 'host.sheets.register({ title: "Before" })');
    const control = bundle("watch-control", 'host.sheets.register({ title: "Control" })');
    const sourceMap = join(directory, "web", "sheet.js.map");

    writeFileSync(sourceMap, '{"version":3,"sources":[]}');

    await app.setExtensionEnabled(owner(app), "watch-ui", true);
    await app.setExtensionEnabled(owner(app), "watch-control", true);
    app.loader.watch();
    const current = () => app.loader.sheets().find((sheet) => sheet.moduleId === "watch-ui");

    writeFileSync(
        join(directory, "index.ts"),
        'export default (host) => { host.sheets.register({ title: "After" }); return []; };',
    );
    await until(() => current()?.title === "After", "bundle index.ts reload");
    const codeGeneration = current()!.generation;

    mkdirSync(join(directory, "web", "nested.assets"), { recursive: true });
    writeFileSync(join(directory, "web", "nested.assets", "lazy.js"), "export const value = 1;\n");
    await until(() => current()?.generation !== codeGeneration, "nested asset reload");
    const assetGeneration = current()!.generation;
    const previousControl = app.loader
        .sheets()
        .find((sheet) => sheet.moduleId === "watch-control")!.generation;

    writeFileSync(sourceMap, '{"version":3,"sources":["changed.ts"]}');
    writeFileSync(join(directory, "web", "README.md"), "Not a browser asset.\n");
    writeFileSync(join(directory, "private.json"), '{"private":true}');
    writeFileSync(join(directory, "helper.ts"), "export const value = 1;");
    mkdirSync(join(directory, "node_modules"), { recursive: true });
    writeFileSync(join(directory, "node_modules", "library.js"), "export const value = 1;");
    writeFileSync(
        join(control, "index.ts"),
        'export default (host) => { host.sheets.register({ title: "Control after edits" }); return []; };',
    );
    await until(
        () =>
            app.loader.sheets().find((sheet) => sheet.moduleId === "watch-control")?.generation !==
            previousControl,
        "control reload after ignored edits",
    );
    assert.equal(current()?.generation, assetGeneration);
    renameSync(join(directory, "web", "nested.assets"), join(directory, "web", "renamed.assets"));
    await until(() => current()?.generation !== assetGeneration, "renamed asset directory reload");
    const renamedGeneration = current()!.generation;

    assert.equal(
        app.extensionSheets
            .asset(owner(app), "watch-ui", renamedGeneration, ["renamed.assets", "lazy.js"])
            .toString(),
        "export const value = 1;\n",
    );
    rmSync(join(directory, "web", "renamed.assets"), { recursive: true });
    await until(
        () => current()?.generation !== renamedGeneration,
        "deleted asset directory reload",
    );
    assert.throws(
        () =>
            app.extensionSheets.asset(owner(app), "watch-ui", current()!.generation, [
                "renamed.assets",
                "lazy.js",
            ]),
        { status: 404 },
    );

    rmSync(join(directory, "index.ts"));
    await until(() => current() === undefined, "deleted bundle entry is uninstalled");
    bundle("watch-ui", 'host.sheets.register({ title: "Restored" })');
    await until(() => current()?.title === "Restored", "restored enabled bundle reloads");

    renameSync(directory, join(app.dataDir, "extensions", "watch-renamed"));
    await until(() => current() === undefined, "renamed bundle is uninstalled");
    assert.equal(app.loader.enabled("watch-renamed"), false);
});

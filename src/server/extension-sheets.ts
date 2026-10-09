/** Native extension GUIs: accepted web bytes and owner-only calls, outside conversation history. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";
import type { ExtensionRpc, ExtensionSheet, SheetInfo } from "./host.ts";

/** Browser assets, not backend source, documents, or arbitrary downloads. MIME types live in http/assets.ts. */
const ASSET_TYPES = new Set([
    ".js",
    ".mjs",
    ".css",
    ".json",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".woff2",
]);

export function isSheetAsset(path: string): boolean {
    return ASSET_TYPES.has(extname(path).toLowerCase());
}

type Asset = { path: string; hash: string };
export type LoadedSheet = {
    info: SheetInfo;
    root: string;
    assets: ReadonlyMap<string, Asset>;
    rpc: ExtensionRpc | undefined;
};

function inside(root: string, path: string): boolean {
    const part = relative(root, path);

    return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function hash(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** Do not follow symlinks, including directory junctions, or publish dotfiles. */
function scan(root: string, directory: string, assets: Map<string, Asset>): void {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) {
            continue;
        }

        const name = directory ? `${directory}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            scan(root, name, assets);
        } else if (entry.isFile() && isSheetAsset(name)) {
            const path = realpathSync(join(root, name));

            if (!inside(root, path)) {
                throw new Error("Sheet assets must stay inside the web folder.");
            }

            assets.set(name, { path, hash: hash(readFileSync(path)) });
        }
    }
}

/** Stage metadata and fingerprints before the loader replaces any installed part of the module. */
export function loadSheet(
    moduleId: string,
    generation: string,
    directory: string,
    definition: Required<ExtensionSheet>,
    rpc: ExtensionRpc | undefined,
): LoadedSheet {
    const moduleRoot = realpathSync(directory);
    const declaredRoot = join(moduleRoot, "web");

    if (lstatSync(declaredRoot).isSymbolicLink()) {
        throw new Error("The web folder must not be a link.");
    }

    const root = realpathSync(declaredRoot);
    const assets = new Map<string, Asset>();

    if (relative(declaredRoot, root) !== "") {
        throw new Error("The web folder must stay at its declared path.");
    }

    scan(root, "", assets);

    if (!assets.has(definition.entry)) {
        throw new Error("The Sheet entry must be a regular JavaScript file in the web folder.");
    }

    return {
        info: {
            moduleId,
            generation,
            title: definition.title,
            wide: definition.wide,
            entry: `/api/extensions/${encodeURIComponent(moduleId)}/assets/${generation}/${definition.entry.split("/").map(encodeURIComponent).join("/")}`,
        },
        root,
        assets,
        rpc,
    };
}

export class ExtensionSheets {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    #current(user: User, moduleId: string, generation: string): { sheet: LoadedSheet; user: User } {
        const current = this.#app.config.userById(user.id);

        if (current?.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        const sheet = this.#app.loader.sheet(moduleId);

        if (sheet === undefined || !this.#app.loader.enabled(moduleId)) {
            throw new HttpError(404, "Extension interface not available");
        }

        if (sheet.info.generation !== generation) {
            throw new HttpError(409, "Extension interface changed; refresh the page");
        }

        return { sheet, user: current };
    }

    /** Check the exact buffer returned to HTTP, not a timestamp or a second read of the file. */
    asset(user: User, moduleId: string, generation: string, parts: string[]): Buffer {
        const { sheet } = this.#current(user, moduleId, generation);
        const asset = sheet.assets.get(parts.join("/"));

        if (asset === undefined) {
            throw new HttpError(404, "Not found");
        }

        let bytes: Buffer;

        try {
            const path = realpathSync(join(sheet.root, ...parts));

            if (path !== asset.path || !inside(sheet.root, path)) {
                throw new Error("Asset moved");
            }

            bytes = readFileSync(path);

            if (realpathSync(join(sheet.root, ...parts)) !== path || hash(bytes) !== asset.hash) {
                throw new Error("Asset changed");
            }
        } catch {
            throw new HttpError(
                409,
                "Extension assets changed; reload the module and refresh the page",
            );
        }

        return bytes;
    }

    /** There is no replay, receipt, conversation entry, or host deadline for these calls. */
    async call(user: User, moduleId: string, input: unknown): Promise<string> {
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
            throw new HttpError(400, "Invalid extension request");
        }

        const { generation, action, payload } = input as Record<string, unknown>;

        if (typeof generation !== "string" || typeof action !== "string" || action.trim() === "") {
            throw new HttpError(400, "An extension request needs a generation and action");
        }

        const { sheet, user: current } = this.#current(user, moduleId, generation);

        if (sheet.rpc === undefined) {
            throw new HttpError(404, "This extension has no RPC handler");
        }

        try {
            const result = await sheet.rpc(action, payload, {
                user: { id: current.id, name: current.name, role: current.role },
            });
            const data = JSON.stringify(result === undefined ? null : result);

            if (data === undefined) {
                throw new Error("Not a JSON result");
            }

            return `{"ok":true,"data":${data}}`;
        } catch {
            // The original exception, cause, result and payload must not reach the HTTP logger or caller.
            throw new HttpError(500, "extension_error");
        }
    }
}

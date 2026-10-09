// Private settings for the example, not a host credential store. This helper stays shared across index.ts reloads.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Settings = { version: number; label: string; endpoint?: string; token?: string };
export type PublicState = {
    version: number;
    label: string;
    hasEndpoint: boolean;
    hasToken: boolean;
};
export type SaveResult = { saved: true; state: PublicState } | { saved: false; error: string };

export async function readSettings(file: string): Promise<Settings> {
    let value: Settings;

    try {
        value = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { version: 0, label: "Pi Pocket" };
        }

        throw new Error("Could not read notifier settings.");
    }

    if (
        value === null ||
        typeof value !== "object" ||
        !Number.isSafeInteger(value.version) ||
        value.version < 0 ||
        typeof value.label !== "string" ||
        (value.endpoint !== undefined && typeof value.endpoint !== "string") ||
        (value.token !== undefined && typeof value.token !== "string")
    ) {
        throw new Error("Could not read notifier settings.");
    }

    return value;
}

export function publicState(settings: Settings): PublicState {
    return {
        version: settings.version,
        label: settings.label,
        hasEndpoint: !!settings.endpoint,
        hasToken: !!settings.token,
    };
}

// One server process owns this data directory. Read the revision inside the write line, not before joining it.
let writing: Promise<void> = Promise.resolve();

export function saveSettings(file: string, payload: unknown): Promise<SaveResult> {
    const operation = writing.then(async (): Promise<SaveResult> => {
        const previous = await readSettings(file);

        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
            return { saved: false, error: "Enter a label and a configuration version." };
        }

        const input = payload as Record<string, unknown>;

        if (input.version !== previous.version) {
            return { saved: false, error: "Configuration changed. Reload it before saving." };
        }

        if (typeof input.label !== "string" || input.label.trim() === "") {
            return { saved: false, error: "Enter a label." };
        }

        const next: Settings = {
            ...previous,
            version: previous.version + 1,
            label: input.label.trim(),
        };

        for (const field of ["endpoint", "token"] as const) {
            if (!Object.hasOwn(input, field)) {
                continue; // Omitted means keep the saved value, never take a masked value from the browser.
            }

            const value = input[field];

            if (value === null) {
                delete next[field];
                continue;
            }

            if (typeof value !== "string" || value.trim() === "" || /[\r\n]/.test(value)) {
                return { saved: false, error: "Enter a value, leave it unchanged, or use Clear." };
            }

            if (field === "endpoint") {
                try {
                    const url = new URL(value);

                    if (
                        !["http:", "https:"].includes(url.protocol) ||
                        url.username ||
                        url.password
                    ) {
                        throw new Error();
                    }
                } catch {
                    return {
                        saved: false,
                        error: "Use an HTTP(S) endpoint without URL user credentials.",
                    };
                }
            }

            next[field] = value;
        }

        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = join(dirname(file), `config-${randomUUID()}.tmp`);

        try {
            await writeFile(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
            await rename(temporary, file);
        } finally {
            await rm(temporary, { force: true });
        }

        return { saved: true, state: publicState(next) };
    });

    writing = operation.then(
        () => {},
        () => {},
    );

    return operation;
}

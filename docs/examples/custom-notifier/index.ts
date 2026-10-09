/** A native notification-settings interface and a tool that uses its private endpoint and token. */
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../../../src/server/host.ts";
import { publicState, readSettings, saveSettings } from "./settings.ts";

export default function customNotifier(host: PocketHost) {
    const file = join(host.dataDir, "custom-notifier", "config.json");

    host.sheets.register({ title: "Custom notifier" });
    host.rpc.handle(async (action, payload) => {
        if (action === "get_state") {
            return publicState(await readSettings(file));
        }

        if (action === "save") {
            return saveSettings(file, payload);
        }

        throw new Error("Unknown notifier action.");
    });

    const notify = defineTool({
        name: "send_notification",
        description:
            "Send a notification using the endpoint configured in the Custom notifier interface.",
        parameters: Type.Object({ message: Type.String({ description: "The notification text" }) }),
        // A cut-off request may already have delivered a notification. Never replay it automatically.
        replay: "unsafe",
        execute: async ({ message }) => {
            const settings = await readSettings(file);

            if (!settings.endpoint || !settings.token) {
                throw new Error("Configure the Custom notifier in Extensions first.");
            }

            try {
                const response = await fetch(settings.endpoint, {
                    method: "POST",
                    redirect: "error",
                    headers: {
                        "content-type": "application/json",
                        authorization: `Bearer ${settings.token}`,
                    },
                    body: JSON.stringify({ label: settings.label, message }),
                    // The example owns this I/O timeout; it is not a host RPC deadline or an undo guarantee.
                    signal: AbortSignal.timeout(10_000),
                });

                await response.body?.cancel();

                if (!response.ok) {
                    throw new Error();
                }

                return { content: [{ type: "text" as const, text: "Notification sent." }] };
            } catch {
                // URLs, network errors, and receiver bodies can all contain credentials.
                throw new Error(
                    "Notification could not be confirmed. Check the receiver before trying again.",
                );
            }
        },
    });

    return defineExtension({ name: "example-custom-notifier", tools: [notify] });
}

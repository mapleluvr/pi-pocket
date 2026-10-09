// A trusted extension's content inside Pocket's own Sheet. No extension state belongs in the store.
import { Component } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { api, closeSheet, notify, store } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

// ESM namespaces survive unmounting. A different generation needs a new browser document.
const loaded = new Map();
let nextInstance = 0;
const CHANGED = "This extension changed. Refresh the page before opening it again.";
const UNAVAILABLE = "This extension interface is no longer available.";
const FAILED = "The extension call failed. It may already have taken effect. It was not retried.";

function current(definition) {
    return store.state.server?.extensionSheets?.find(
        (sheet) => sheet.moduleId === definition.moduleId,
    );
}

/** Each open gets its own callbacks, even when the same module is opened again immediately. */
function instance(sheet) {
    const definition = sheet.definition;
    let live = true;
    const active = () =>
        live &&
        store.state.sheet === sheet &&
        store.state.me?.role === "owner" &&
        current(definition)?.generation === definition.generation;

    return {
        id: ++nextInstance,
        active,
        dismiss: () => {
            if (live && store.state.sheet === sheet) {
                closeSheet();
            }
        },
        dispose: () => {
            live = false;
        },
        host: {
            async rpc(action, payload) {
                if (!active()) {
                    throw new Error(UNAVAILABLE);
                }

                try {
                    const answer = await api(
                        `extensions/${encodeURIComponent(definition.moduleId)}/rpc`,
                        {
                            generation: definition.generation,
                            action,
                            payload,
                        },
                    );

                    if (!active()) {
                        throw new Error(UNAVAILABLE);
                    }

                    if (
                        answer === null ||
                        typeof answer !== "object" ||
                        Array.isArray(answer) ||
                        answer.ok !== true ||
                        !Object.hasOwn(answer, "data")
                    ) {
                        throw new Error(FAILED);
                    }

                    return answer.data;
                } catch {
                    // api() can carry a server's raw text; none of it belongs in an extension's error UI.
                    throw new Error(active() ? FAILED : UNAVAILABLE);
                }
            },
            notify(level, message) {
                if (active()) {
                    notify(level, message);
                }
            },
            close() {
                if (active()) {
                    closeSheet();
                }
            },
        },
    };
}

/** Unlike the app's general Boundary, this one never logs the original render exception. */
class ContentBoundary extends Component {
    state = { failed: false };

    componentDidCatch() {
        this.setState({ failed: true });
    }

    render({ children }, { failed }) {
        return failed
            ? html`<div class="error-box">The extension interface could not render. Close it and try again.</div>`
            : children;
    }
}

export function ExtensionSheet({ sheet }) {
    const definition = sheet.definition;
    const scope = useMemo(() => instance(sheet), [sheet]);
    const [content, setContent] = useState(null);
    const accepted = current(definition);
    const previous = loaded.get(definition.moduleId);
    const unavailable = store.state.me?.role !== "owner" || !accepted;
    const changed =
        accepted?.generation !== definition.generation ||
        (previous !== undefined && previous !== definition.generation);

    useEffect(() => {
        if (scope.active() && !changed) {
            loaded.set(definition.moduleId, definition.generation);
            import(definition.entry).then(
                (module) => {
                    if (scope.active()) {
                        setContent(
                            typeof module.default === "function"
                                ? { scope, component: module.default }
                                : { scope, failed: true },
                        );
                    }
                },
                () => {
                    if (scope.active()) {
                        setContent({ scope, failed: true });
                    }
                },
            );
        }

        return scope.dispose;
    }, [scope]);

    const Component = content?.scope === scope ? content.component : null;
    const problem = unavailable
        ? UNAVAILABLE
        : changed
          ? CHANGED
          : content?.scope === scope && content.failed
            ? "The extension interface could not load. Refresh the page to try again."
            : null;

    return html`<${Sheet} title=${definition.title} wide=${definition.wide} onClose=${scope.dismiss}>
        ${
            problem
                ? html`<div class="error-box">${problem}</div>
                <button class="button" onClick=${() => location.reload()}>Refresh page</button>`
                : Component
                  ? html`<${ContentBoundary} key=${scope.id}><${Component} host=${scope.host} /><//>`
                  : html`<${Loader} label="Loading extension interface" />`
        }
    <//>`;
}

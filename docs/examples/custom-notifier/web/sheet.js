// An extension-owned component, not another Sheet. Pocket supplies only its instance-bound host callbacks.
import { useEffect, useState } from "preact/hooks";
import { html, Loader } from "/ui.js";

export default function Notifier({ host }) {
    const [state, setState] = useState(null);
    const [label, setLabel] = useState("");
    const [endpoint, setEndpoint] = useState("");
    const [token, setToken] = useState("");
    const [clearEndpoint, setClearEndpoint] = useState(false);
    const [clearToken, setClearToken] = useState(false);
    const [busy, setBusy] = useState(true);
    const [problem, setProblem] = useState("");

    const apply = (next) => {
        setState(next);
        setLabel(next.label);
        setEndpoint("");
        setToken("");
        setClearEndpoint(false);
        setClearToken(false);
    };

    const load = async () => {
        setBusy(true);
        setProblem("");

        try {
            apply(await host.rpc("get_state"));
        } catch {
            setProblem("Could not load notifier settings.");
        } finally {
            setBusy(false);
        }
    };

    const save = async (event) => {
        event.preventDefault();
        setBusy(true);
        setProblem("");

        try {
            const result = await host.rpc("save", {
                version: state.version,
                label,
                ...(clearEndpoint || endpoint ? { endpoint: clearEndpoint ? null : endpoint } : {}),
                ...(clearToken || token ? { token: clearToken ? null : token } : {}),
            });

            if (result.saved) {
                apply(result.state);
                host.notify("info", "Notifier settings saved.");
            } else {
                setProblem(result.error);
            }
        } catch (error) {
            setProblem(error.message);
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        load();
    }, [host]);

    if (!state) {
        return problem
            ? html`<p class="error-box">${problem}</p>
                  <button class="button" onClick=${load}>Reload settings</button>`
            : html`<${Loader} label="Loading notifier settings" />`;
    }

    return html`<form onSubmit=${save}>
        <p class="muted small">
            Configure send_notification here. Saved credentials are never filled back in.
        </p>
        <label class="field">
            <span class="label">Label</span>
            <input
                id="notifier-label"
                value=${label}
                disabled=${busy}
                onInput=${(event) => setLabel(event.currentTarget.value)}
            />
        </label>
        <label class="field">
            <span class="label"
                >Endpoint ${state.hasEndpoint ? "(configured)" : "(not configured)"}</span
            >
            <input
                id="notifier-endpoint"
                type="password"
                autocomplete="off"
                value=${endpoint}
                disabled=${busy || clearEndpoint}
                placeholder=${state.hasEndpoint ? "Leave blank to keep" : "HTTP(S) endpoint"}
                onInput=${(event) => setEndpoint(event.currentTarget.value)}
            />
        </label>
        <label class="list-item">
            <input
                id="notifier-clear-endpoint"
                type="checkbox"
                style=${{ width: "auto" }}
                checked=${clearEndpoint}
                disabled=${busy}
                onChange=${(event) => setClearEndpoint(event.currentTarget.checked)}
            />
            Clear saved endpoint
        </label>
        <label class="field">
            <span class="label">Token ${state.hasToken ? "(configured)" : "(not configured)"}</span>
            <input
                id="notifier-token"
                type="password"
                autocomplete="off"
                value=${token}
                disabled=${busy || clearToken}
                placeholder=${state.hasToken ? "Leave blank to keep" : "Bearer token"}
                onInput=${(event) => setToken(event.currentTarget.value)}
            />
        </label>
        <label class="list-item">
            <input
                id="notifier-clear-token"
                type="checkbox"
                style=${{ width: "auto" }}
                checked=${clearToken}
                disabled=${busy}
                onChange=${(event) => setClearToken(event.currentTarget.checked)}
            />
            Clear saved token
        </label>
        ${problem && html`<p class="error-box">${problem}</p>`}
        <div class="actions">
            <button id="notifier-save" class="button primary" type="submit" disabled=${busy}>
                Save
            </button>
            <button class="button ghost" type="button" disabled=${busy} onClick=${load}>
                Reload settings
            </button>
        </div>
    </form>`;
}

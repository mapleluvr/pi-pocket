# Custom notifier

A Pocket-native extension with its own GUI, a module-local RPC handler, and a `send_notification` tool. It shows how an author can design an interface and share its business state with a tool, without adding that business to Pocket's core. It is not an adapter for a terminal plugin or a general credential store.

## Try it

1. Copy this whole directory into `<dataDir>/extensions/custom-notifier/`. Use the data directory of the Pocket copy you intend to test, not a running installation's real data.
2. As the owner, open **Menu → Extensions**, enable **custom-notifier**, and choose **Open**. Opening and saving need no conversation or available model.
3. Set a label, an HTTP(S) endpoint you control, and a bearer token. Choose **Save**.
4. In a test conversation, ask Pi to use `send_notification` with a message. The tool reads the settings at call time and sends the notification.

The receiver gets a POST with `Authorization: Bearer <token>` and JSON `{ "label": "…", "message": "…" }`. A 2xx response acknowledges it. Redirects are rejected rather than followed, so a 307 cannot repeat the POST or forward its credentials. The response body is discarded, including on failure; it is not a tool result.

The example uses the app's Preact instance, import map, and existing form styles. The host supplies the sheet around the content. `index.ts` has a type-only import for this repository's type checker; Node removes it when running the copied module. Adjust that import's path if an editor outside the repository needs it.

## Files and state

- `index.ts` declares the sheet, RPC actions, and tool.
- `web/sheet.js` is the custom content component. It gets instance-bound `rpc`, `notify`, and `close` through its `host` prop.
- `settings.ts` reads and writes `<host.dataDir>/custom-notifier/config.json`, outside the extension's `web/` directory.

`get_state` returns only the revision, label, and whether an endpoint and token are configured. Stored endpoints and tokens are never filled back into the form. An endpoint may itself contain credentials, so it is treated as private too.

`save` takes the revision the form read and its new label. For each private field:

| Input           | Meaning                       |
| --------------- | ----------------------------- |
| Field omitted   | Keep the current stored value |
| Nonempty string | Replace it                    |
| `null`          | Clear it                      |

The form leaves blank fields out of the request and sends `null` only for a checked **Clear** option. A label-only edit therefore keeps the latest credentials. A stale revision returns a business conflict; choose **Reload settings**, review the current state, and edit again. A successful save or reload clears the form's private inputs.

Writes are serialized in the helper within this process, read the current revision inside that queue, and replace the file by renaming a temporary file. Rename prevents partial JSON reads; the queue and revision check prevent concurrent stale writes from silently replacing a newer configuration. This is not a power-loss durability guarantee. New directories and files request POSIX modes `0700` and `0600`; Windows relies on the data directory's ACLs. The file is plaintext, and clearing a field is not secure erasure of backups or old disk contents.

Imported backend helpers are not hot-reloaded. A change to `settings.ts` needs a server restart; changing `index.ts` or supported `web/` assets reloads the module. If this page has already imported the GUI, using its next generation needs a full page refresh.

## Failure and privacy boundaries

A missing endpoint or token prevents delivery. The tool's outbound HTTP wait has a ten-second timeout owned by this example, not a host RPC deadline. A timeout or failed reply may follow a delivered notification: check the receiver before trying again. The tool is not replay-safe, and neither the GUI SDK nor the tool automatically repeats an unknown delivery.

Credentials are sent in the owner's RPC request body and stored in the private file. They are not command arguments, model parameters or results, Durable records, broadcasts, navigation parameters, or persistent browser state. The tool intentionally sends the token to the configured receiver; choose that receiver and its transport accordingly. Use HTTPS or a suitable trusted connection both to Pocket and to the receiver.

This protects the example's normal data flow, not the machine against the owner or a malicious extension. Drop-ins run with the owner's machine rights, their GUI shares the app's origin, and the agent's existing file tools can read files the owner can read. A password field, file mode, or fixed error message is not a sandbox.

## Verification

From the repository root:

```sh
node --test test/extension-sheet-notifier.test.ts
```

The test copies this directory unchanged into a disposable Pocket app. It drives the actual mobile GUI and RPC, invokes the real tool through a scripted model, and checks delivery at a controlled HTTP receiver. It also checks concurrent revisions, keep/replace/clear behavior, malformed private storage, and a receiver that echoes sentinel secrets. Those sentinels must remain absent from model requests, committed Durable records and document history, broadcasts, Markdown exports, browser storage, and error logs. A real Chromium installation is needed for the browser portion.

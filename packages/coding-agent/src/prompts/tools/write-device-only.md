Executes a mounted `xd://` tool device: `path` is `xd://<tool>` and `content` is the device's JSON arguments object. `read xd://` lists the mounted devices; `read xd://<tool>` shows a device's full docs.

Outside active plan mode, this `write` tool permits `xd://` device calls and read-tier `agent://<id>` peer messages. During plan mode, it can also write `local://` sandbox drafts required by that workflow; working-tree paths remain rejected.

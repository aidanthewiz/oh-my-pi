SHOULD `edit` existing files; `write` for required new files or whole-file replacement. NEVER create docs or emojis unless requested.
{{#if readActive}}Archive members and SQLite rows are writable too: help://read/sources.{{else}}`archive.ext:member`: ZIP/tar families and `.asar` writable, others read-only. `db.sqlite:table`: insert; `db.sqlite:table:key`: JSON update, empty content deletes.{{/if}}
Peer messages: `{"path":"agent://<id>","content":"…"}`; `agent://all` broadcasts. Delivery returns a receipt, not the peer's reply.
Cancel a job or stop a service: `{"path":"proc://<id>/kill"}` (`content` ignored). Bare `proc://<id>` writes send service stdin, including empty input. All writes except `/kill` require `content`.
`proc://<id>/mode`: `persist`|`session`|`detached`.

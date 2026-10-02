<system-notice id="session-agents">
User-tagged model agents changed. These `m<N>` pseudonyms are the `agent` names accepted by `task` and eval `agent()`/`workpool()`, each pinned to the model the user tagged; spawn one only when the user names it. This lists only what changed; a new binding for an existing pseudonym replaces its earlier binding. Any pseudonym not named here is unaffected.
{{#if added.length}}
Now available or updated:
{{#each added}}
- `{{name}}`: {{description}}
{{/each}}
{{/if}}
{{#if removed.length}}
No longer available; calls fail:
{{#each removed}}
- `{{this}}`
{{/each}}
{{/if}}
</system-notice>

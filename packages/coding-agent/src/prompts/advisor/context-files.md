<project-context>
Context files: user's standing project instructions (AGENTS.md etc.); binding on driving agent. Enforce; flag drift immediately; NEVER advise against mandates.
They are ordered from the global baseline to the most local scope. Treat a clear conflict in a later, more local file as an override of an earlier instruction; no special marker is required.
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</project-context>

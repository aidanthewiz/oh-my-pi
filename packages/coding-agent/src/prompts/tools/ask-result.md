{{#if timedOut}}The form timed out and is incomplete. Only explicit answers are retained below; they do not approve any pending operation:{{else}}User answers:{{/if}}
{{json}}
{{#if notes}}
Option notes:
{{#each notes}}
- {{question}}: {{option}} [{{name}}={{jsonStringify value}}] — {{text}}
{{/each}}
{{/if}}

{{#if interrupted}}Ask interrupted by message. Answers the user gave before it:{{else}}{{#if timedOut}}The form timed out and is incomplete. Only explicit answers are retained below; they do not approve any pending operation:{{else}}User answers:{{/if}}{{/if}}
{{json}}
{{#if notes}}
Option notes:
{{#each notes}}
- {{question}}: {{option}} [{{name}}={{jsonStringify value}}] — {{text}}
{{/each}}
{{/if}}

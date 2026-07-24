    (function() {
      'use strict';

      // ============================================================
      // SHARE VIEWER BOOTSTRAP
      // ============================================================
      //
      // Served by the omp relay at /s/<id>; the AES-256-GCM key rides in the
      // URL fragment and never leaves the browser. Resolves the session JSON
      // and hands it to template.js via `window.__OMP_SESSION_DATA__`:
      //   1. hex ids -> secret GitHub gist holding base64(sealed blob)
      //   2. anything else -> relay blob store at /s/<id>/raw
      // Sealed layout: [12B IV][AES-256-GCM(gzip(session JSON))].

      var GIST_ID_RE = /^[0-9a-f]{20,64}$/;
      var SHARE_PATH_RE = /\/s\/([A-Za-z0-9_-]{10,64})\/?$/;
      var AUTH_STORAGE_KEY = 'coreforce.agent-collab.browser-session';
      var AUTH_OVERLAY_ID = 'coreforce-agent-collab-auth';
      var AUTH_POLL_MS = 2000;

      function decodeBase64(text) {
        var binary = atob(text);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }

      function decodeBase64Url(text) {
        var b64 = text.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        return decodeBase64(b64);
      }

      function clearBrowserSession() {
        try { sessionStorage.removeItem(AUTH_STORAGE_KEY); } catch (_err) {}
      }

      function readBrowserSession() {
        try {
          var value = JSON.parse(sessionStorage.getItem(AUTH_STORAGE_KEY) || 'null');
          if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value.accessToken) ||
              typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now() + 30000) {
            clearBrowserSession();
            return null;
          }
          return value;
        } catch (_err) {
          clearBrowserSession();
          return null;
        }
      }

      function storeBrowserSession(accessToken, expiresIn) {
        try {
          sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
            accessToken: accessToken,
            expiresAt: Date.now() + expiresIn * 1000,
          }));
        } catch (_err) {}
      }

      function showAuthorizationCode(code) {
        var overlay = document.getElementById(AUTH_OVERLAY_ID);
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = AUTH_OVERLAY_ID;
          overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:20px;background:#111;color:#eee;font:14px system-ui,sans-serif';
          var card = document.createElement('div');
          card.style.cssText = 'max-width:520px;padding:28px;border:1px solid #555;border-radius:10px;background:#1b1b1b;text-align:center';
          var title = document.createElement('h1');
          title.textContent = 'Coreforce authentication required';
          title.style.cssText = 'font-size:20px;margin:0 0 16px';
          var instruction = document.createElement('p');
          instruction.textContent = 'Ask the session host to approve this code.';
          var command = document.createElement('code');
          command.id = AUTH_OVERLAY_ID + '-command';
          command.style.cssText = 'display:block;padding:12px;border:1px solid #555;border-radius:6px;background:#000;font-size:16px;user-select:all';
          var waiting = document.createElement('p');
          waiting.textContent = 'This share opens automatically after authorization.';
          waiting.style.cssText = 'color:#aaa;margin:16px 0 0';
          card.append(title, instruction, command, waiting);
          overlay.append(card);
          document.body.append(overlay);
        }
        document.getElementById(AUTH_OVERLAY_ID + '-command').textContent = 'Approval code: ' + code;
      }

      function hideAuthorizationCode() {
        var overlay = document.getElementById(AUTH_OVERLAY_ID);
        if (overlay) overlay.remove();
      }

      async function getBrowserToken() {
        var stored = readBrowserSession();
        if (stored) {
          var validation = await fetch('/auth/browser/session', {
            headers: { Authorization: 'Bearer ' + stored.accessToken },
          });
          if (validation.status === 204) return stored.accessToken;
          clearBrowserSession();
        }
        var challengeResponse = await fetch('/auth/browser/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (challengeResponse.status === 404) return null;
        if (!challengeResponse.ok) throw new Error('Browser authorization failed: HTTP ' + challengeResponse.status);
        var challenge = await challengeResponse.json();
        if (!challenge || typeof challenge.challengeId !== 'string' ||
            typeof challenge.userCode !== 'string' || typeof challenge.expiresIn !== 'number') {
          throw new Error('Relay returned an invalid browser challenge.');
        }
        showAuthorizationCode(challenge.userCode);
        try {
          var deadline = Date.now() + challenge.expiresIn * 1000;
          while (Date.now() < deadline) {
            await new Promise(function(resolve) { setTimeout(resolve, AUTH_POLL_MS); });
            var response = await fetch('/auth/browser/status', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ challengeId: challenge.challengeId }),
            });
            if (response.status === 202) continue;
            if (response.status === 410) throw new Error('Browser authorization code expired; reload for a new code.');
            if (!response.ok) throw new Error('Browser authorization failed: HTTP ' + response.status);
            var status = await response.json();
            if (!status || status.status !== 'approved' || typeof status.accessToken !== 'string' ||
                typeof status.expiresIn !== 'number') {
              throw new Error('Relay returned an invalid browser session.');
            }
            storeBrowserSession(status.accessToken, status.expiresIn);
            return status.accessToken;
          }
          throw new Error('Browser authorization code expired; reload for a new code.');
        } finally {
          hideAuthorizationCode();
        }
      }

      async function fetchGistBlob(id) {
        var res = await fetch('https://api.github.com/gists/' + id, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (res.status === 404) throw new Error('This share no longer exists (gist deleted?).');
        if (!res.ok) throw new Error('Gist fetch failed: HTTP ' + res.status);
        var gist = await res.json();
        var files = Object.values(gist.files || {});
        var file = files.find(function(f) { return /\.ompshare\.txt$/.test(f.filename); }) || files[0];
        if (!file) throw new Error('Gist has no files.');
        var text = file.content;
        if (!text || file.truncated) {
          var raw = await fetch(file.raw_url);
          if (!raw.ok) throw new Error('Gist raw fetch failed: HTTP ' + raw.status);
          text = await raw.text();
        }
        return decodeBase64(text.replace(/\s+/g, ''));
      }

      async function fetchServerBlob(id, authToken) {
        var res = await fetch('/s/' + id + '/raw', {
          headers: authToken ? { Authorization: 'Bearer ' + authToken } : {},
        });
        if (res.status === 404 || res.status === 410) {
          throw new Error('This share no longer exists (expired or deleted).');
        }
        if (!res.ok) throw new Error('Share fetch failed: HTTP ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
      }

      async function load() {
        var match = SHARE_PATH_RE.exec(location.pathname);
        if (!match) throw new Error('Bad share URL; expected /s/<id>.');
        var keyText = location.hash.replace(/^#/, '');
        if (!keyText) throw new Error('Share link is missing its #key fragment; paste the full link.');
        var keyBytes;
        try {
          keyBytes = decodeBase64Url(keyText);
        } catch (_err) {
          throw new Error('Share key is not valid base64url.');
        }
        if (keyBytes.length !== 32) throw new Error('Share key must decode to 32 bytes.');

        var authToken = await getBrowserToken();
        var id = match[1];
        var sealed = await (GIST_ID_RE.test(id) ? fetchGistBlob(id) : fetchServerBlob(id, authToken));
        if (sealed.length <= 12) throw new Error('Sealed session blob is truncated.');

        var key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
        var plain;
        try {
          plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: sealed.subarray(0, 12) },
            key,
            sealed.subarray(12)
          );
        } catch (_err) {
          throw new Error('Decryption failed: wrong or corrupted #key.');
        }

        var data = await new Response(
          new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))
        ).json();
        if (data && data.header && data.header.title) {
          document.title = data.header.title + ' — Coreforce Agent Collab';
        }
        return data;
      }

      var pending = load();
      // template.js surfaces the failure in-page; swallow the duplicate here
      // so the console does not report an unhandled rejection.
      pending.catch(function() {});
      window.__OMP_SESSION_DATA__ = pending;
    })();

import { clientId, setTransport } from '@wailsio/runtime';

type AndroidBridge = {
  invokeAsync?: (callbackId: string, payload: string) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

declare global {
  interface Window {
    wails?: AndroidBridge;
    _wailsAndroidCallback?: (id: string, response: string | null, error: string | null, payloadToken?: string | null) => void;
  }
}

function callbackId(): string {
  return `a${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}

function parseEnvelope(response: string): unknown {
  const envelope = JSON.parse(response || '{}') as {
    ok?: boolean;
    error?: string;
    text?: unknown;
    data?: unknown;
  };
  if (!envelope.ok) {
    throw new Error(envelope.error || 'unknown runtime call error');
  }
  return 'text' in envelope ? envelope.text : envelope.data;
}

/**
 * Android WebView cannot deliver fetch() POST bodies to shouldInterceptRequest.
 * Wails routes runtime calls through window.wails.invokeAsync instead.
 * Large responses are staged under /__binding_payload__/{token} to avoid OOM.
 */
export function installAndroidTransport(): boolean {
  const bridge = typeof window !== 'undefined' ? window.wails : undefined;
  if (!bridge || typeof bridge.invokeAsync !== 'function') {
    return false;
  }

  const pending = new Map<string, Pending>();

  window._wailsAndroidCallback = (id, response, error, payloadToken) => {
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);
    if (error) {
      entry.reject(new Error(error));
      return;
    }

    const finish = (raw: string) => {
      try {
        entry.resolve(parseEnvelope(raw));
      } catch (err) {
        entry.reject(err);
      }
    };

    if (payloadToken) {
      const url = `${window.location.origin}/__binding_payload__/${encodeURIComponent(payloadToken)}`;
      void fetch(url, { method: 'GET', cache: 'no-store' })
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(`large binding payload failed: HTTP ${res.status}`);
          }
          return res.text();
        })
        .then(finish)
        .catch((err) => entry.reject(err));
      return;
    }

    finish(response || '{}');
  };

  setTransport({
    call(objectID, method, windowName, args) {
      return new Promise((resolve, reject) => {
        const id = callbackId();
        pending.set(id, { resolve, reject });
        try {
          bridge.invokeAsync!(
            id,
            JSON.stringify({
              object: objectID,
              method,
              windowName,
              args: args ?? null,
              clientId,
            }),
          );
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    },
  });

  return true;
}

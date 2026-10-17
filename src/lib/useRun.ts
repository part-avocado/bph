import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientCommand, LogLine, RunState, ServerEvent } from "../../shared/types";

export type Connection = "connecting" | "open" | "reconnecting" | "closed";

/** Live view of a run, with automatic reconnects. The run keeps going server-side regardless. */
export function useRun(runId: string, getToken: () => Promise<string | null>) {
  const [state, setState] = useState<RunState | null>(null);
  const [draft, setDraft] = useState<{ version: number; body: string; score: number | null } | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const ws = useRef<WebSocket | null>(null);
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    // A new run starts from a clean slate rather than showing the previous run's state.
    setState(null);
    setDraft(null);
    setLog([]);
    setConnection("connecting");

    // Same backoff whether the token fetch or the socket itself failed.
    function retry() {
      setConnection("reconnecting");
      timer = setTimeout(connect, Math.min(8000, 400 * 2 ** attempt++));
    }

    async function connect() {
      let token: string | null = null;
      try {
        token = await tokenRef.current();
      } catch {
        // Clerk couldn't refresh the session (offline, say); try again below.
      }
      if (closed) return;
      if (!token) return retry();
      const proto = location.protocol === "https:" ? "wss" : "ws";
      // The token travels as a subprotocol, not in the URL, so it never lands in request logs.
      const socket = new WebSocket(`${proto}://${location.host}/api/runs/${runId}/ws`, ["bearer", token]);
      ws.current = socket;
      socket.onopen = () => {
        attempt = 0;
        setConnection("open");
      };
      socket.onmessage = (msg) => {
        // A replaced socket can still deliver buffered frames; only the current one updates state.
        if (closed || ws.current !== socket) return;
        let ev: ServerEvent;
        try {
          ev = JSON.parse(msg.data as string) as ServerEvent;
        } catch {
          return;
        }
        if (ev.type === "state") setState(ev.state);
        else if (ev.type === "draft") setDraft({ version: ev.version, body: ev.body, score: ev.score });
        else if (ev.type === "log") setLog((prev) => (ev.replace ? ev.lines : [...prev, ...ev.lines].slice(-400)));
      };
      socket.onclose = () => {
        if (closed || ws.current !== socket) return;
        retry();
      };
    }
    void connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws.current?.close();
      ws.current = null;
      setConnection("closed");
    };
  }, [runId]);

  const send = useCallback((cmd: ClientCommand) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(cmd));
  }, []);

  return { state, draft, log, connection, send };
}

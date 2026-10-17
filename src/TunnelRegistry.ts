import { DurableObject } from "cloudflare:workers";

export class TunnelRegistry extends DurableObject {
  private deviceWs: WebSocket | null = null;
  private nextStreamId = 1;
  private pendingRequests = new Map<number, { 
    writer: WritableStreamDefaultWriter; 
    resolve: (res: Response) => void; 
    readable: ReadableStream;
  }>();
  private isHandshaked = false;

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WIRE PROTOCOL V2.0: REAL-TIME HEALTH STATUS ROUTE
    if (url.pathname === "/device/check") {
      for (let i = 0; i < 30; i++) {
        if (this.deviceWs && this.isHandshaked) break;
        await new Promise(r => setTimeout(r, 100));
      }

      const isOnline = this.deviceWs !== null && this.isHandshaked;
      console.log(`• [DURABLE OBJECT STATUS] Live controle uitgevoerd. Status operationeel: ${isOnline}`);
      
      if (!isOnline) {
        return new Response("Device Offline of TLS Handshake incompleet", { status: 503 });
      }
      return new Response("Device Online", { status: 200 });
    }

    if (url.pathname === "/status") {
      return new Response(this.deviceWs && this.isHandshaked ? "online" : "offline", {
        status: this.deviceWs && this.isHandshaked ? 200 : 503
      });
    }

    // ✅ DEBUG VERSIE: WebSocket upgrade-aanvraag met try-catch en stap-voor-stap logging
    if (url.pathname === "/device") {
      console.log("🟢 [DO] /device WebSocket upgrade ontvangen.");

      try {
        const [client, server] = Object.values(new WebSocketPair());
        console.log("✅ [DO] WebSocketPair gemaakt.");
        
        if (this.deviceWs) {
          try { this.deviceWs.close(4000, "Replaced by newer connection"); } catch(e){}
        }

        this.deviceWs = server;
        this.isHandshaked = false;

        this.ctx.acceptWebSocket(server);
        console.log("✅ [DO] acceptWebSocket aangeroepen.");

        // We laten de Sec-WebSocket-Protocol weg conform AI advies om runtime-interferentie te uitsluiten
        return new Response(null, { 
          status: 101, 
          webSocket: client
        });
      } catch (err: any) {
        console.error("🚨 [DO] WebSocket upgrade fout:", err.message, err.stack);
        return new Response(JSON.stringify({ 
          error: "WebSocket upgrade failed", 
          detail: err.message 
        }), { 
          status: 502, 
          headers: { "Content-Type": "application/json" } 
        });
      }
    }

    if (!this.deviceWs || !this.isHandshaked) {
      return new Response(JSON.stringify({ error: "Durable Object Ingress Handshake Incomplete" }), { 
        status: 503, 
        headers: { "Content-Type": "application/json" } 
      });
    }

    const streamId = this.nextStreamId++;
    const allowedHeaders = ['accept', 'accept-encoding', 'accept-language', 'if-none-match', 'if-modified-since', 'user-agent'];
    const forwardedHeaders: Record<string, string> = {};
    for (const header of allowedHeaders) {
      const val = request.headers.get(header);
      if (val) forwardedHeaders[header] = val;
    }

    const reqHeadPayload = JSON.stringify({
      m: request.method,
      p: url.pathname + url.search,
      h: forwardedHeaders
    });

    const encoder = new TextEncoder();
    const payloadBytes = encoder.encode(reqHeadPayload);

    const frame = new Uint8Array(5 + payloadBytes.length);
    frame[0] = 0x10; // REQ_HEAD
    
    const view = new DataView(frame.buffer);
    view.setUint32(1, streamId, false);
    frame.set(payloadBytes, 5);

    this.deviceWs.send(frame);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    return new Promise<Response>((resolve) => {
      this.pendingRequests.set(streamId, { writer, resolve, readable });

      setTimeout(() => {
        if (this.pendingRequests.has(streamId)) {
          this.pendingRequests.delete(streamId);
          try { writer.abort("Gateway Timeout"); } catch(e){}
          resolve(new Response("Gateway Timeout (ESP32 reageerde niet binnen 10s)", { status: 544 }));
        }
      }, 10000);
    });
  }

  // HIBERNATION API EVENT HANDLERS
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (!(message instanceof ArrayBuffer)) {
      ws.close(4003, "Protocol error: Text frame received");
      return;
    }

    const rawBytes = new Uint8Array(message);
    const frame = new Uint8Array(rawBytes); 
    if (frame.length < 5) return;

    const type = frame[0];
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const streamId = view.getUint32(1, false);
    const payload = frame.slice(5);
    const decoder = new TextDecoder();

    if (streamId === 0) {
      if (type === 0x01) { // HELLO
        try {
          const helloData = JSON.parse(decoder.decode(payload));
          if (helloData.v !== 1) {
            ws.close(4002, "Unsupported protocol version");
            return;
          }

          const ackPayload = new TextEncoder().encode(JSON.stringify({
            v: 1,
            max_frame: Math.min(helloData.max_frame, 4096),
            max_streams: Math.min(helloData.max_streams, 2),
            request_timeout_s: 10,
            idle_timeout_s: 30,
            ping_interval_s: 30
          }));

          const ackFrame = new Uint8Array(5 + ackPayload.length);
          ackFrame[0] = 0x02; // HELLO_ACK
          new DataView(ackFrame.buffer).setUint32(1, 0, false);
          ackFrame.set(ackPayload, 5);

          ws.send(ackFrame);
          this.isHandshaked = true;
          console.log("🟢 [DO] Handshake succesvol voltooid met ESP32.");
        } catch (e) {
          ws.close(4003, "Malformed HELLO payload");
        }
      }
      return;
    }

    const activeReq = this.pendingRequests.get(streamId);
    if (!activeReq) return;

    if (type === 0x20) { // RES_HEAD
      try {
        const resHead = JSON.parse(decoder.decode(payload));
        const headers = new Headers(resHead.h);
        headers.set("Content-Security-Policy", "default-src 'self' 'unsafe-inline';");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("X-Frame-Options", "DENY");
        
        const response = new Response(activeReq.readable, {
          status: resHead.s || 200,
          headers: headers
        });
        activeReq.resolve(response);
      } catch (e) {
        ws.close(4003, "Malformed RES_HEAD payload");
      }
    } 
    else if (type === 0x21) { // RES_BODY
      try {
        await activeReq.writer.write(payload);
      } catch(e) {
        this.pendingRequests.delete(streamId);
      }
    } 
    else if (type === 0x22) { // RES_END
      this.pendingRequests.delete(streamId);
      try { await activeReq.writer.close(); } catch(e){}
    } 
    else if (type === 0x30) { // RESET
      this.pendingRequests.delete(streamId);
      try { await activeReq.writer.abort(); } catch(e){}
      activeReq.resolve(new Response("Stream reset door device", { status: 502 }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    this.deviceWs = null;
    this.isHandshaked = false;
    console.log(`🔴 [DO] WebSocket gesloten: code=${code} reason=${reason}`);
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error("🚨 [DO] WebSocket error:", error);
    this.deviceWs = null;
    this.isHandshaked = false;
  }
}

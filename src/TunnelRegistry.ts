import { DurableObject } from "cloudflare:workers";

interface WebSocketState {
  handshaked: boolean;
}

export class TunnelRegistry extends DurableObject {
  private nextStreamId = 1;
  private pendingRequests = new Map<number, { 
    writer: WritableStreamDefaultWriter; 
    resolve: (res: Response) => void; 
    readable: ReadableStream;
  }>();

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
  }

  // ✅ HIBERNATION-SAFE STATE EXTRACTION
  private getDeviceWs(): WebSocket | null {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        const att = ws.deserializeAttachment() as WebSocketState | null;
        if (att && att.handshaked) return ws;
      } catch (e) {
        // Mislukte deserialisatie negeren
      }
    }
    return null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── ✅ GECOMBINEERDE HEALTH CHECK: AI DEBUG LOGS + 5 SECONDEN TIMING FIX ──
    if (url.pathname === "/device/check") {
      // 1. Toon alle actieve WebSockets en hun attachments direct in de Cloudflare stream
      const sockets = this.ctx.getWebSockets();
      console.log(`🔍 [DO] getWebSockets() = ${sockets.length} socket(s)`);
      for (let i = 0; i < sockets.length; i++) {
        try {
          const att = sockets[i].deserializeAttachment();
          console.log(`🔍 [DO] socket[${i}] attachment = ${JSON.stringify(att)}`);
        } catch(e: any) {
          console.log(`🔍 [DO] socket[${i}] deserialize error: ${e.message}`);
        }
      }

      // 2. Verruimde 5 seconden loop (50 iteraties * 100ms) voor trage hardware synchronisatie
      for (let i = 0; i < 50; i++) { 
        if (this.getDeviceWs()) break;
        await new Promise(r => setTimeout(r, 100));
      }
      
      const ws = this.getDeviceWs();
      const isOnline = ws !== null;
      console.log(`• [DO STATUS] Live controle. Operationeel: ${isOnline}`);
      
      if (!isOnline) {
        return new Response("Device Offline of TLS Handshake incompleet", { status: 503 });
      }
      return new Response("Device Online", { status: 200 });
    }

    if (url.pathname === "/status") {
      const ws = this.getDeviceWs();
      return new Response(ws ? "online" : "offline", {
        status: ws ? 200 : 503
      });
    }

    // ── WebSocket upgrade voor de ESP32 ──
    if (url.pathname === "/device") {
      console.log("🟢 [DO] /device WebSocket upgrade ontvangen.");
      try {
        const [client, server] = Object.values(new WebSocketPair());
        console.log("✅ [DO] WebSocketPair gemaakt.");

        // Sluit eventuele achtergebleven zombietunnels binnen deze DO context
        const existing = this.ctx.getWebSockets();
        for (const oldWs of existing) {
          try { oldWs.close(4000, "Replaced by newer connection"); } catch(e){}
        }

        // Hibernation state initialisatie
        server.serializeAttachment({ handshaked: false });
        this.ctx.acceptWebSocket(server);
        console.log("✅ [DO] acceptWebSocket aangeroepen.");

        return new Response(null, { status: 101, webSocket: client });
      } catch (err: any) {
        console.error("🚨 [DO] WebSocket upgrade fout:", err.message, err.stack);
        return new Response(JSON.stringify({ error: err.message }), { 
          status: 502, headers: { "Content-Type": "application/json" } 
        });
      }
    }

    // ── Stateless HTTP proxy naar device ──
    const deviceWs = this.getDeviceWs();
    if (!deviceWs) {
      return new Response(JSON.stringify({ error: "Durable Object Ingress Handshake Incomplete" }), { 
        status: 503, headers: { "Content-Type": "application/json" } 
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

    deviceWs.send(frame);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    return new Promise<Response>((resolve) => {
      this.pendingRequests.set(streamId, { writer, resolve, readable });
      setTimeout(() => {
        if (this.pendingRequests.has(streamId)) {
          this.pendingRequests.delete(streamId);
          try { writer.abort("Gateway Timeout"); } catch(e){}
          resolve(new Response("Gateway Timeout", { status: 544 }));
        }
      }, 10000);
    });
  }

  // ── HIBERNATION API EVENT HANDLERS ──
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

    // ── Binaire handshake op stream 0 ──
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

          // ✅ PERSIST STATE IN ATTACHMENT: Sla de status direct op in de WebSocket-laag
          ws.serializeAttachment({ handshaked: true });
          console.log("🟢 [DO] Handshake succesvol voltooid en opgeslagen in attachment.");
        } catch (e) {
          ws.close(4003, "Malformed HELLO payload");
        }
      }
      return;
    }

    // ── Binaire HTTP proxy data streaming ──
    const activeReq = this.pendingRequests.get(streamId);
    if (!activeReq) return;

    if (type === 0x20) { // RES_HEAD -> Response stream openen voor de browser
      try {
        const resHead = JSON.parse(decoder.decode(payload));
        const plainHeaders: Record<string, string> = {};
        
        // 1. Kopieer de originele headers van de ESP32 en dwing alle sleutels naar kleine letters
        if (resHead.h) {
          for (const [key, value] of Object.entries(resHead.h)) {
            plainHeaders[key.toLowerCase()] = value as string;
          }
        }
        
        // 2. Garandeer uitsluitend een HTML fallback als er écht geen content-type is meegegeven
        if (!plainHeaders["content-type"]) {
          plainHeaders["content-type"] = "text/html; charset=utf-8";
        }
        
        // 3. Voeg de vereiste security- en transfer-headers expliciet toe
        plainHeaders["content-security-policy"] = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data:; connect-src 'self' wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline';";
        plainHeaders["x-content-type-options"] = "nosniff";
        plainHeaders["referrer-policy"] = "no-referrer";
        plainHeaders["x-frame-options"] = "DENY";
        plainHeaders["transfer-encoding"] = "chunked"; // Vereist voor stabiele streaming op iOS Safari

        const response = new Response(activeReq.readable, {
          status: resHead.s || 200, 
          headers: plainHeaders
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
    console.log(`🔴 [DO] WebSocket gesloten: code=${code} reason=${reason}`);
  }
}

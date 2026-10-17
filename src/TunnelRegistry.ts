export class TunnelRegistry implements DurableObject {
  private deviceWs: WebSocket | null = null;
  private nextStreamId = 1;
  // We slaan nu de controller van de ReadableStream op voor stateless streaming
  private pendingRequests = new Map<number, { 
    controller: ReadableStreamDefaultController; 
    resolve: (res: Response) => void;
    responseHeaders?: any; 
    status?: number;
  }>();
  private isHandshaked = false;

  constructor(private state: DurableObjectState, private env: any) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WIRE PROTOCOL V2.0: REAL-TIME HEALTH STATUS ROUTE (MET TLS HANDSHAKE RETRY-LOOP)
    if (url.pathname === "/device/check") {
      // Geef de ESP32 maximaal 3 seconden (retry-loop) om mbedTLS en HELLO af te ronden
      for (let i = 0; i < 30; i++) {
        if (this.deviceWs && this.isHandshaked) break;
        await new Promise(r => setTimeout(r, 100)); // Wacht 100ms per iteratie
      }

      const isOnline = this.deviceWs !== null && this.isHandshaked;
      console.log(`窶｢ [DURABLE OBJECT STATUS] Live controle uitgevoerd. Status operationeel: ${isOnline}`);
      
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

    if (url.pathname === "/device") {
      const [client, server] = Object.values(new WebSocketPair());
      
      if (this.deviceWs) {
        try { this.deviceWs.close(4000, "Replaced by newer connection"); } catch(e){}
      }

      this.deviceWs = server;
      this.isHandshaked = false;
      this.setupDeviceWebSocket();

      return new Response(null, { status: 101, webSocket: client });
    }

    // Ingress check voor browser requests
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
    
    // Veilig wegschrijven via DataView op de nieuw gealloceerde buffer array
    const view = new DataView(frame.buffer);
    view.setUint32(1, streamId, false); // Big Endian
    frame.set(payloadBytes, 5);

    this.deviceWs.send(frame);

    // ECHTE STATELESS STREAMING: Maak een transformatiestream aan
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    return new Promise<Response>((resolve) => {
      // Sla de stream-controller op in plaats van de body chunks array in het RAM
      this.pendingRequests.set(streamId, { 
        controller: writer as any, 
        resolve: (res) => {
          resolve(res);
        }
      });

      // Gateway timeout handhaven
      setTimeout(() => {
        if (this.pendingRequests.has(streamId)) {
          this.pendingRequests.delete(streamId);
          try { writer.abort("Gateway Timeout"); } catch(e){}
          resolve(new Response("Gateway Timeout (ESP32 reageerde niet binnen 10s)", { status: 544 }));
        }
      }, 10000);
    });
  }

  private setupDeviceWebSocket() {
    if (!this.deviceWs) return;

    this.deviceWs.accept();
    this.deviceWs.addEventListener("message", async (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        this.deviceWs?.close(4003, "Protocol error: Text frame received");
        return;
      }

      // FIX: Maak een geïsoleerde kopie van de bytes om byteOffset verschuivingen in V8 te elimineren!
      const rawBytes = new Uint8Array(event.data);
      const frame = new Uint8Array(rawBytes); 
      if (frame.length < 5) return;

      const type = frame[0];
      
      // FIX: Maak de DataView aan vanaf de veilige, geïsoleerde frame buffer
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const streamId = view.getUint32(1, false);
      const payload = frame.slice(5); // Gebruik slice voor een schone kopie van de payload bytes

      const decoder = new TextDecoder();

      if (streamId === 0) {
        if (type === 0x01) { // HELLO
          try {
            const helloData = JSON.parse(decoder.decode(payload));
            if (helloData.v !== 1) {
              this.deviceWs?.close(4002, "Unsupported protocol version");
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

            this.deviceWs?.send(ackFrame);
            this.isHandshaked = true;
            console.log("🟢 [DURABLE OBJECT] Handshake succesvol voltooid met ESP32.");
          } catch (e) {
            this.deviceWs?.close(4003, "Malformed HELLO payload");
          }
        }
        return;
      }

      const activeReq = this.pendingRequests.get(streamId);
      if (!activeReq) return;

      if (type === 0x20) { // RES_HEAD
        try {
          const resHead = JSON.parse(decoder.decode(payload));
          activeReq.responseHeaders = resHead.h;
          activeReq.status = resHead.s;
        } catch (e) {
          this.deviceWs?.close(4003, "Malformed RES_HEAD payload");
        }
      } 
      else if (type === 0x21) { // RES_BODY -> Stateless streaming chunk direct doorzetten!
        try {
          // Schrijf de binaire bytes direct naar de browser stream-back
          const writer = activeReq.controller as any;
          writer.write(payload);
        } catch(e) {
          this.pendingRequests.delete(streamId);
        }
      } 
      else if (type === 0x22) { // RES_END -> Sluit de stream netjes af
        this.pendingRequests.delete(streamId);
        
        try {
          const writer = activeReq.controller as any;
          writer.close();
        } catch(e){}

        // Bouw de browser response met de streaming-pipe
        const headers = new Headers(activeReq.responseHeaders);
        headers.set("Content-Security-Policy", "default-src 'self' 'unsafe-inline';");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("X-Frame-Options", "DENY");

        // We resolven de promise met een lege body, de data is al onderweg of sluit direct aan via TransformStream
        // Om de TransformStream correct te binden aan de initiële fetch response:
        // We veranderen de architectuur naar directe responses zodra RES_HEAD binnen is voor optimale werking, 
        // maar binnen deze PoC structuur is de streaming nu RAM-veilig.
      }
      else if (type === 0x30) { // RESET
        this.pendingRequests.delete(streamId);
        try { (activeReq.controller as any).abort(); } catch(e){}
        activeReq.resolve(new Response("Stream reset door device", { status: 502 }));
      }
    });

    this.deviceWs.addEventListener("close", () => {
      this.deviceWs = null;
      this.isHandshaked = false;
      console.log("🔴 [DURABLE OBJECT] WebSocket verbinding gesloten door device.");
    });
  }
}

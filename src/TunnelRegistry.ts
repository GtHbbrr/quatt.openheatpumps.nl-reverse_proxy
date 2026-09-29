export class TunnelRegistry implements DurableObject {
  private deviceWs: WebSocket | null = null;
  private nextStreamId = 1;
  private pendingRequests = new Map<number, { resolve: (res: Response) => void, responseHeaders?: any, bodyChunks: Uint8Array[], status?: number }>();
  private isHandshaked = false;

  constructor(private state: DurableObjectState, private env: any) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/status") {
      return new Response(this.deviceWs && this.isHandshaked ? "online" : "offline", {
        status: this.deviceWs && this.isHandshaked ? 200 : 503
      });
    }

    if (url.pathname === "/device") {
      const [client, server] = Object.values(new WebSocketPair());
      
      if (this.deviceWs) {
        this.deviceWs.close(4000, "Replaced by newer connection");
      }

      this.deviceWs = server;
      this.isHandshaked = false;
      this.setupDeviceWebSocket();

      return new Response(null, { status: 101, webSocket: client });
    }

    if (!this.deviceWs || !this.isHandshaked) {
      return new Response("Warmtepomp is momenteel offline", { status: 503 });
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

    // Binaire frame format conform Sectie 5
    const frame = new Uint8Array(5 + payloadBytes.length);
    frame[0] = 0x10; // REQ_HEAD byte index
    const view = new DataView(frame.buffer);
    view.setUint32(1, streamId, false); // Big Endian
    frame.set(payloadBytes, 5);

    this.deviceWs.send(frame);

    return new Promise<Response>((resolve) => {
      this.pendingRequests.set(streamId, { resolve, bodyChunks: [] });

      setTimeout(() => {
        if (this.pendingRequests.has(streamId)) {
          this.pendingRequests.delete(streamId);
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

      const frame = new Uint8Array(event.data);
      if (frame.length < 5) return;

      const type = frame[0];
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const streamId = view.getUint32(1, false);
      const payload = frame.subarray(5);

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
      else if (type === 0x21) { // RES_BODY
        activeReq.bodyChunks.push(new Uint8Array(payload));
      } 
      else if (type === 0x22) { // RES_END
        this.pendingRequests.delete(streamId);

        const totalLength = activeReq.bodyChunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const completeBody = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of activeReq.bodyChunks) {
          completeBody.set(chunk, offset);
          offset += chunk.length;
        }

        const headers = new Headers(activeReq.responseHeaders);
        headers.set("Content-Security-Policy", "default-src 'self' 'unsafe-inline';");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("X-Frame-Options", "DENY");

        const response = new Response(completeBody, {
          status: activeReq.status || 200,
          headers: headers
        });
        activeReq.resolve(response);
      }
      else if (type === 0x30) { // RESET
        this.pendingRequests.delete(streamId);
        activeReq.resolve(new Response("Stream reset door device", { status: 502 }));
      }
    });

    this.deviceWs.addEventListener("close", () => {
      this.deviceWs = null;
      this.isHandshaked = false;
    });
  }
}


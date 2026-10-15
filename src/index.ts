import { TunnelRegistry } from "./TunnelRegistry";
export { TunnelRegistry };

export interface Env {
  TUNNEL_REGISTRY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. ESP32 Ingress: Accepteer de socket ALTIJD onvoorwaardelijk
    if (url.pathname === "/device") {
      const doId = env.TUNNEL_REGISTRY.idFromName("global-poc-gate");
      const stub = env.TUNNEL_REGISTRY.get(doId);
      return await stub.fetch(request);
    }

    // 2. Mobiele Paring: Zet direct de cookie zonder checks of hashes
    if (url.pathname === "/api/pair" || url.pathname === "/pair") {
      console.log("🔓 [PoC BYPASS] Onvoorwaardelijke paring geactiveerd.");
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "oq_pump=poc-bypass-token; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000"
        }
      });
    }

    // 3. Browser Proxying: Stuur direct door naar het globale Durable Object
    const doId = env.TUNNEL_REGISTRY.idFromName("global-poc-gate");
    const stub = env.TUNNEL_REGISTRY.get(doId);
    return await stub.fetch(request);
  }
};

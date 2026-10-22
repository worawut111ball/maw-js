interface Env {
  SHRINE_KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // GET /api/shrine — get prayer counts
    if (url.pathname === "/api/shrine" && request.method === "GET") {
      const total = parseInt(await env.SHRINE_KV.get("total") || "0");
      const oraclesRaw = await env.SHRINE_KV.get("oracles");
      const oracles = oraclesRaw ? JSON.parse(oraclesRaw) : {};
      return Response.json({ total, oracles }, { headers: cors });
    }

    // POST /api/shrine/pray — increment prayer (rate limited)
    if (url.pathname === "/api/shrine/pray" && request.method === "POST") {
      const { oracle } = await request.json() as { oracle: string };

      // Rate limit: max 10 prayers per IP per minute
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const rateKey = `rate:${ip}`;
      const rateCount = parseInt(await env.SHRINE_KV.get(rateKey) || "0");
      if (rateCount >= 30) {
        return Response.json({ error: "ใจเย็นๆ สวดช้าๆ ได้บุญเยอะกว่า 🙏", total: parseInt(await env.SHRINE_KV.get("total") || "0") }, { status: 429, headers: cors });
      }
      await env.SHRINE_KV.put(rateKey, (rateCount + 1).toString(), { expirationTtl: 60 });

      // Increment total
      const total = parseInt(await env.SHRINE_KV.get("total") || "0") + 1;
      await env.SHRINE_KV.put("total", total.toString());

      // Increment per-oracle
      const oraclesRaw = await env.SHRINE_KV.get("oracles");
      const oracles = oraclesRaw ? JSON.parse(oraclesRaw) : {};
      oracles[oracle] = (oracles[oracle] || 0) + 1;
      await env.SHRINE_KV.put("oracles", JSON.stringify(oracles));

      return Response.json({ total, oracle: oracles[oracle] }, { headers: cors });
    }

    // Everything else — let assets handle (index.html)
    return new Response(null, { status: 404 });
  },
};

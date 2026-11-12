import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";

// Base de datos: Upstash Redis (se conecta sola desde Vercel). Sin ella, usa memoria (solo para pruebas).
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;
const mem = (globalThis.__mem ||= { runs: {}, ids: [] });
const store = {
  get: async (id) => (redis ? redis.get("run:" + id) : mem.runs[id]),
  set: async (r) => (redis ? redis.set("run:" + r.id, r) : void (mem.runs[r.id] = r)),
  async add(r) { await this.set(r); redis ? await redis.lpush("runs", r.id) : mem.ids.unshift(r.id); },
  async recent() {
    if (!redis) return mem.ids.slice(0, 300).map((i) => mem.runs[i]).filter(Boolean);
    const ids = await redis.lrange("runs", 0, 299);
    return ids.length ? (await redis.mget(...ids.map((i) => "run:" + i))).filter(Boolean) : [];
  },
};

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
const code = (s) => norm(s).replace(/[^a-z0-9]/g, "");

// Respuestas y claves: viven solo en el servidor.
const M = {
  1: { check: (a) => { const v = norm(a); return /winnie|pooh|pu\b|oso/.test(v) && /verde|shrek/.test(v) && /tej|bufanda|lana|agujas|hil/.test(v); },
    wrong: "Incompleto. Nombrá al personaje, decí qué tiene de raro su color y qué está haciendo.",
    hint: "Es un oso famoso de los dibujos animados, pero acá no tiene su color de siempre. Buscá en la zona verde de abajo del lienzo." },
  2: { check: (a) => code(a) === "debugtumo", wrong: "Contraseña incorrecta. Atrapá los bugs del Arcade para conseguirla.",
    hint: "Los bugs rebotan contra los bordes. No los persigas: esperá cerca de un borde y hacé clic cuando lleguen.", payload: { code: "DEBUG-TUMO" } },
  3: { check: (a) => code(a) === "ritmo", wrong: "Esa no es la clave del estudio. Completá las secuencias de la consola.",
    hint: "Cada pad tiene un color y una nota distinta. Decí en voz alta los colores mientras suenan y repetilos en orden.", payload: { code: "RITMO" } },
  4: { check: (a) => code(a) === "render", wrong: "Palabra incorrecta. Revisá TODAS las caras del cubo y el número de cada una.",
    hint: "Cada cara tiene un número chiquito en la esquina. Ordená las letras del 1 al 6 y formás una palabra muy usada en 3D.",
    payload: { faces: { front: [3, "N"], back: [6, "R"], right: [1, "R"], left: [5, "E"], top: [4, "D"], bottom: [2, "E"] } } },
  5: { check: (a) => code(a) === "bucle", wrong: "Esa no es la salida del programa. Seguí el código paso a paso.",
    hint: "i += 2 salta de a dos: posiciones 0, 2, 4, 6, 8. Anotá la letra de cada una (la primera es la 0).",
    payload: { letters: ["B", "x", "U", "k", "C", "q", "L", "w", "E", "z"] } },
  6: { check: (a) => code(a) === "prompt", wrong: "Clave incorrecta. Encontrá los 3 errores de la imagen generada por IA.",
    hint: "Las IA de imágenes suelen fallar con tres cosas: las manos, los relojes y los textos escritos.", payload: { code: "PROMPT" } },
  7: { check: (a) => code(a) === "accion", wrong: "Esa no es la palabra de la claqueta. Ajustá bien la cámara.",
    hint: "Mové el foco de a poquito hasta que los bordes se vean nítidos. La exposición va cerca del medio.", payload: { word: "ACCIÓN" } },
};
const TOTAL = 7, PEN = 60;

const pub = (r) => ({
  id: r.id, team: r.team, isDev: r.dev, stage: r.stage, total: TOTAL, hints: r.hints, mistakes: r.mistakes,
  startedAt: r.startedAt, finishedAt: r.finishedAt, now: Date.now(),
  elapsed: Math.round(((r.finishedAt || r.progressAt) - r.startedAt) / 1000), penalty: r.hints.length * PEN,
});
const advance = async (r) => {
  const now = Date.now();
  r.stage++; r.progressAt = now; if (r.stage >= TOTAL) r.finishedAt = now;
  await store.set(r); return pub(r);
};

export default async function handler(req, res) {
  const send = (c, o) => res.status(c).json(o);
  try {
   const p = new URL(req.url, "http://x").pathname.split("/").filter(Boolean).slice(1);
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const [a, id, k, m] = p;

    if (a === "ranking") {
      const all = new URL(req.url, "http://x").searchParams.get("scope") === "all", since = all ? 0 : Date.now() - 12 * 3600 * 1000;
      const ranking = (await store.recent()).filter((r) => !r.dev && r.startedAt >= since).map((r) => {
        const x = pub(r);
        return { team: r.team, stage: r.stage, finished: !!r.finishedAt, hints: r.hints.length, mistakes: r.mistakes, score: x.elapsed + x.penalty };
      }).sort((x, y) => y.stage - x.stage || x.score - y.score).slice(0, 50);
      return send(200, { total: TOTAL, ranking });
    }
    if (a !== "runs") return send(404, { error: "No existe" });

    if (req.method === "POST" && !id) {
      const team = String(b.team ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
      if (!team) return send(400, { error: "Falta el nombre del equipo" });
      const now = Date.now();
      const r = { id: randomUUID(), team, dev: b.dev === true, stage: 0, hints: [], mistakes: 0, startedAt: now, progressAt: now, finishedAt: null };
      await store.add(r);
      return send(201, pub(r));
    }

    const r = await store.get(id);
    if (!r) return send(404, { error: "Partida no encontrada" });
    if (!k) return send(200, pub(r));

    if (k === "module") {
      const n = Number(m);
      if (!M[n]) return send(404, { error: "Módulo inexistente" });
      if (n > r.stage + 1) return send(403, { error: "Módulo bloqueado" });
      return send(200, M[n].payload || {});
    }
    if (k === "answer") {
      const n = Number(b.module);
      if (!M[n] || n !== r.stage + 1) return send(409, { error: "Ese módulo no está activo" });
      if (!M[n].check(String(b.answer ?? ""))) {
        r.mistakes++; await store.set(r);
        return send(200, { correct: false, message: M[n].wrong, run: pub(r) });
      }
      return send(200, { correct: true, run: await advance(r) });
    }
    if (k === "hint") {
      const n = Number(b.module);
      if (!M[n] || n > r.stage + 1) return send(403, { error: "Módulo bloqueado" });
      if (n === r.stage + 1 && !r.hints.includes(n)) { r.hints.push(n); await store.set(r); }
      return send(200, { hint: M[n].hint, run: pub(r) });
    }
    if (k === "skip") {
      if (!r.dev) return send(403, { error: "No permitido" });
      return send(200, { run: r.stage >= TOTAL ? pub(r) : await advance(r) });
    }
    return send(404, { error: "No existe" });
  } catch (e) {
    return send(500, { error: "Error del servidor: " + e.message });
  }
}

export const now = () => Number(process.hrtime.bigint()) / 1e6;
export function summarize(name, xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r = { name, n: s.length, min: +s[0]?.toFixed(0), p50: +q(0.5)?.toFixed(0), p95: +q(0.95)?.toFixed(0), max: +s.at(-1)?.toFixed(0) };
  console.log(JSON.stringify(r));
  return r;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const randId = (n) => {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  return Array.from({ length: n }, () => a[Math.floor(Math.random() * a.length)]).join("");
};

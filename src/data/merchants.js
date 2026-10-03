/** Merchant name pool for the mock feed — deterministic per exchange via seed. */
const FIRST = ['Crypto', 'Fast', 'Alpha', 'Prime', 'Delta', 'Nord', 'Volga', 'Siber', 'Astra', 'Quantum',
  'Orbit', 'Vertex', 'Titan', 'Lunar', 'Zenit', 'Atlas', 'Nexus', 'Cobalt', 'Granit', 'Omega'];
const SECOND = ['Exchange', 'Trade', 'Capital', 'Pay', 'Desk', 'Broker', 'Hub', 'Group', 'Finance', 'Swap',
  'Flow', 'Point', 'Line', 'Bridge', 'Station'];
const SOLO = ['RubleKing', 'FiatMaster', 'TetherDom', 'SwiftRuble', 'P2P_Boss', 'MoneyRiver', 'ExpressCash',
  'SafeDeal24', 'TopChange', 'InstantPay', 'GoldStream', 'WhiteSwap', 'RocketOTC', 'BlueHarbor'];

export function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function merchantName(rnd) {
  if (rnd() < 0.42) return SOLO[Math.floor(rnd() * SOLO.length)] + (rnd() < 0.4 ? Math.floor(10 + rnd() * 89) : '');
  return FIRST[Math.floor(rnd() * FIRST.length)] + SECOND[Math.floor(rnd() * SECOND.length)];
}

import net from 'node:net';

/** Minimal CIDR matching for IPv4 / IPv6 (IPv4-mapped IPv6 addresses are normalised). */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

function ipv4ToBigInt(ip: string): bigint {
  return ip.split('.').reduce((acc, oct) => (acc << 8n) | BigInt(Number(oct)), 0n);
}

function ipv6ToBigInt(ip: string): bigint {
  let addr = ip;
  // Embedded IPv4 tail
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const n = ipv4ToBigInt(v4[1]);
    addr = addr.replace(v4[1], `${((n >> 16n) & 0xffffn).toString(16)}:${(n & 0xffffn).toString(16)}`);
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = addr.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(fill).fill('0'), ...t];
  if (groups.length !== 8) throw new Error(`Invalid IPv6 address: ${ip}`);
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g || '0', 16)), 0n);
}

export interface Cidr {
  v: 4 | 6;
  base: bigint;
  mask: bigint;
  text: string;
}

export function parseCidr(text: string): Cidr {
  const [addrRaw, bitsRaw] = text.trim().split('/');
  const addr = normalizeIp(addrRaw);
  const v = net.isIPv4(addr) ? 4 : net.isIPv6(addr) ? 6 : 0;
  if (!v) throw new Error(`Invalid CIDR: ${text}`);
  const width = v === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? width : Number.parseInt(bitsRaw, 10);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) throw new Error(`Invalid CIDR prefix: ${text}`);
  const all = (1n << BigInt(width)) - 1n;
  const mask = bits === 0 ? 0n : (all << BigInt(width - bits)) & all;
  const value = v === 4 ? ipv4ToBigInt(addr) : ipv6ToBigInt(addr);
  return { v, base: value & mask, mask, text };
}

export function ipInCidr(ipRaw: string, cidr: Cidr): boolean {
  const ip = normalizeIp(ipRaw);
  const v = net.isIPv4(ip) ? 4 : net.isIPv6(ip) ? 6 : 0;
  if (v !== cidr.v) return false;
  const value = v === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
  return (value & cidr.mask) === cidr.base;
}

export class CidrList {
  readonly cidrs: Cidr[];
  constructor(entries: string[]) {
    this.cidrs = entries.map(parseCidr);
  }
  get empty(): boolean {
    return this.cidrs.length === 0;
  }
  /** Empty list allows everything. */
  allows(ip: string): boolean {
    if (this.empty) return true;
    return this.cidrs.some((c) => ipInCidr(ip, c));
  }
}

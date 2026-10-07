/** Крошечный роутер: метод + шаблон пути с :params. Без зависимостей. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  ip: string;
  requestId: string;
  auth: { userId: string; tgId: string } | null;
  body: unknown;
  header(name: string): string | null;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  parts: string[]; // сегменты, ':x' = параметр
  handler: Handler;
  auth: boolean;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, opts: { auth: boolean }): void {
    this.routes.push({ method, parts: split(pattern), handler, auth: opts.auth });
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const segs = split(path);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = route.parts[i]!;
        const s = segs[i]!;
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(s);
        else if (p !== s) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  /** Есть ли путь при другом методе — чтобы вернуть 405, а не 404. */
  allowsPath(path: string): boolean {
    const segs = split(path);
    return this.routes.some((r) => r.parts.length === segs.length
      && r.parts.every((p, i) => p.startsWith(':') || p === segs[i]));
  }
}

function split(p: string): string[] {
  return p.split('/').filter(Boolean);
}

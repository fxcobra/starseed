import type { Request, Response } from "express";
import type { EventEmitter } from "node:events";
import type { VendorEvent } from "./vendorRuntime.js";

export function initSse(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`event: ready\ndata: {}\n\n`);
}

export function writeSseEvent(res: Response, event: VendorEvent) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function attachEmitter(req: Request, res: Response, emitter: EventEmitter) {
  initSse(res);

  const onEvent = (evt: VendorEvent) => writeSseEvent(res, evt);
  emitter.on("event", onEvent);

  req.on("close", () => {
    emitter.off("event", onEvent);
  });
}


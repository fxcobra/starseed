export function initSse(res) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`event: ready\ndata: {}\n\n`);
}
export function writeSseEvent(res, event) {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
}
export function attachEmitter(req, res, emitter) {
    initSse(res);
    const onEvent = (evt) => writeSseEvent(res, evt);
    emitter.on("event", onEvent);
    req.on("close", () => {
        emitter.off("event", onEvent);
    });
}

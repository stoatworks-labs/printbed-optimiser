/// <reference lib="webworker" />
// The packer, off the page's thread: footprint rasterising and packing take up to a few seconds on big plates.
import { LayoutState, type LayoutMessage, type LayoutReply } from '../lib/layout/service.ts';

const state = new LayoutState();

self.onmessage = (e: MessageEvent<LayoutMessage>) => {
  const { id } = e.data;
  let reply: LayoutReply;
  try {
    reply = { id, ok: true, result: state.handle(e.data) };
  } catch (err) {
    reply = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply);
};

/** The work's result, or "late" once `deadline` (epoch ms) passes first. The work itself is not stopped. */
export async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T | "late"> {
  if (deadline === Infinity) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), Math.max(0, deadline - Date.now()))));
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A request body read to its end, unless it grows past `maxBytes` or is still arriving at `deadline`. */
export async function readBody(
  request: Request,
  opts: { maxBytes: number; deadline: number },
): Promise<Uint8Array | "too_large" | "too_slow"> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > opts.maxBytes) return "too_large";
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await beforeDeadline(reader.read(), opts.deadline);
      if (next === "late") return "too_slow";
      if (next.done) break;
      size += next.value.length;
      if (size > opts.maxBytes) return "too_large";
      chunks.push(next.value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

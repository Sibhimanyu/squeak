import crypto from "node:crypto";
import type { Duplex } from "node:stream";

/**
 * A tiny server-side WebSocket (RFC 6455) for text frames only — all the
 * desktop relay carries. Avoids pulling `ws` into the daemon. Handles the
 * upgrade handshake, client→server unmasking, fragmentation, ping/pong and
 * close; sends unmasked text/close/pong.
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(secWebSocketKey: string): string {
  return crypto
    .createHash("sha1")
    .update(secWebSocketKey + WS_GUID)
    .digest("base64");
}

export interface WsConnection {
  sendText(text: string): void;
  close(code?: number, reason?: string): void;
  onText(cb: (text: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

export function upgradeToWebSocket(
  socket: Duplex,
  headers: Record<string, string | string[] | undefined>,
): WsConnection {
  const key = headers["sec-websocket-key"];
  if (typeof key !== "string") throw new Error("missing Sec-WebSocket-Key");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "\r\n",
    ].join("\r\n"),
  );

  const textHandlers: ((t: string) => void)[] = [];
  const closeHandlers: ((c: number, r: string) => void)[] = [];
  let buffer = Buffer.alloc(0);
  let fragmentOpcode = 0;
  let fragments: Buffer[] = [];
  let closed = false;

  const emitClose = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    for (const h of closeHandlers) h(code, reason);
  };

  const sendFrame = (opcode: number, payload: Buffer) => {
    if (closed && opcode !== 0x8) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  };

  const deliver = (opcode: number, payload: Buffer) => {
    if (opcode === 0x1) {
      const text = payload.toString("utf8");
      for (const h of textHandlers) h(text);
    } else if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      sendFrame(0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
      emitClose(code, reason);
      socket.end();
    } else if (opcode === 0x9) {
      sendFrame(0xa, payload); // pong
    }
    // 0xa pong, 0x2 binary: ignored
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const b0 = buffer[0]!;
      const b1 = buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        len = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      let mask: Buffer | undefined;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + len) return;
      let payload = buffer.subarray(offset, offset + len);
      if (mask) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i]! ^ mask[i & 3]!;
        payload = unmasked;
      } else {
        payload = Buffer.from(payload);
      }
      buffer = buffer.subarray(offset + len);

      if (opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          deliver(fragmentOpcode, Buffer.concat(fragments));
          fragments = [];
          fragmentOpcode = 0;
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          deliver(opcode, payload);
        } else {
          fragmentOpcode = opcode;
          fragments = [payload];
        }
      } else {
        deliver(opcode, payload); // control frames are never fragmented
      }
    }
  });

  socket.on("close", () => emitClose(1006, "socket closed"));
  socket.on("error", () => emitClose(1006, "socket error"));

  return {
    sendText: (text) => sendFrame(0x1, Buffer.from(text, "utf8")),
    close: (code = 1000, reason = "") => {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2, "utf8");
      sendFrame(0x8, payload);
      emitClose(code, reason);
      socket.end();
    },
    onText: (cb) => textHandlers.push(cb),
    onClose: (cb) => closeHandlers.push(cb),
  };
}
